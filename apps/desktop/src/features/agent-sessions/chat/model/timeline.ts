import type {
  AgentActivityItemDto,
  AgentSessionSnapshotDto,
  AgentSessionStatusDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { createsMedia } from "./media";

type ItemOf<K extends AgentActivityItemDto["kind"]> = Extract<
  AgentActivityItemDto,
  { kind: K }
>;

/** A resolved request as the timeline keeps it. */
export type InteractionRecord = ItemOf<"interaction">;

/** One tool call with the outcome of the permission asked for it. */
export interface ToolRow {
  item: ItemOf<"tool_call">;
  permission: InteractionRecord | null;
}

/** Service records: an error, a mode or settings change, an unknown update. */
export type NoticeItem =
  | ItemOf<"error">
  | ItemOf<"generic">
  | ItemOf<"mode_change">
  | ItemOf<"config_change">
  | InteractionRecord;

/**
 * The failure of the last turn known only from the session status: a
 * replay carries no turn outcomes (DF-226 R3).
 */
export interface StatusFailure {
  kind: "status_failure";
}

/** A turn result worth showing: anything but a plain end of turn. */
export type OutcomeItem =
  | ItemOf<"turn_outcome">
  | ItemOf<"interrupted">
  | StatusFailure;

export type TimelineEntry =
  | { kind: "user"; id: string; item: ItemOf<"user_message"> }
  | { kind: "message"; id: string; item: ItemOf<"agent_message"> }
  | { kind: "reasoning"; id: string; item: ItemOf<"reasoning"> }
  /** Consecutive tool calls; `id` is the first call's. */
  | { kind: "tools"; id: string; rows: ToolRow[] }
  | { kind: "plan"; id: string; item: ItemOf<"plan"> }
  | { kind: "question"; id: string; item: InteractionRecord }
  /** Repeats of the same record in a row show once, the last one, with their count. */
  | { kind: "notice"; id: string; item: NoticeItem; count: number }
  | { kind: "outcome"; id: string; item: OutcomeItem };

/**
 * A finished turn folded into one summary row: everything between the
 * user's message and the agent's last message. Folding is presentation
 * only; `entries` keeps the whole turn.
 */
export interface TurnSummary {
  /** Entries shown while the turn is folded. */
  visibleIds: ReadonlySet<string>;
  /** Folded items; each tool call counts, those that created media too. */
  count: number;
  durationMs: number | null;
  /** The entry the summary row follows: the user's message, if any. */
  afterId: string | null;
}

export interface TimelineTurn {
  id: string;
  /** The turn the agent is working on now. */
  live: boolean;
  entries: TimelineEntry[];
  /** Null for a live turn and a turn without anything to fold. */
  summary: TurnSummary | null;
}

const SESSION_GROUP = "session";

/** The items of one turn, or of the session between turns. */
interface ItemGroup {
  id: string;
  items: AgentActivityItemDto[];
}

/**
 * The timeline of a session: its items grouped by turn in order, projected
 * into entries. A pure function of the runtime snapshot and the session
 * status, so a reload or a resubscription projects the same timeline.
 */
export function projectTimeline(
  snapshot: Pick<AgentSessionSnapshotDto, "items" | "turn">,
  status: AgentSessionStatusDto | null = null,
): TimelineTurn[] {
  const liveTurn =
    snapshot.turn.phase !== "none" ? snapshot.turn.turnId : null;
  const groups: ItemGroup[] = [];
  for (const item of snapshot.items) {
    const id = item.turnId ?? SESSION_GROUP;
    const last = groups.at(-1);
    const known =
      item.turnId === null
        ? last?.id === SESSION_GROUP
          ? last
          : undefined
        : groups.find((group) => group.id === id);
    if (known) known.items.push(item);
    else groups.push({ id, items: [item] });
  }
  const failedTurn = statusFailedTurn(groups, liveTurn, status);
  return groups.map((group, index) => {
    const live = group.id !== SESSION_GROUP && group.id === liveTurn;
    const entries = projectTurn(group.items);
    if (group === failedTurn) {
      entries.push({
        kind: "outcome",
        id: `status-failure:${group.id}`,
        item: { kind: "status_failure" },
      });
    }
    return {
      id: group.id === SESSION_GROUP ? `${SESSION_GROUP}:${index}` : group.id,
      live,
      entries,
      summary:
        live || group.id === SESSION_GROUP
          ? null
          : summarize(entries, group.items),
    };
  });
}

/**
 * The last turn, when the session status says it failed and the turn has
 * no outcome of its own: a replayed turn that failed (DF-226 R3). A turn
 * the runtime ended or is running keeps its own result.
 */
function statusFailedTurn(
  groups: ItemGroup[],
  liveTurn: string | null,
  status: AgentSessionStatusDto | null,
): ItemGroup | undefined {
  if (status?.state !== "idle" || status.stopReason !== "error") return;
  const last = lastWhere(groups, (group) => group.id !== SESSION_GROUP);
  if (!last || last.id === liveTurn) return;
  const ended = last.items.some(
    (item) => item.kind === "turn_outcome" || item.kind === "interrupted",
  );
  return ended ? undefined : last;
}

function projectTurn(items: AgentActivityItemDto[]): TimelineEntry[] {
  const toolIds = new Set(
    items.filter((item) => item.kind === "tool_call").map((item) => item.id),
  );
  const permissions = new Map<string, InteractionRecord>();
  for (const item of items) {
    if (
      item.kind === "interaction" &&
      item.request === "permission" &&
      item.toolCallId &&
      toolIds.has(item.toolCallId)
    ) {
      permissions.set(item.toolCallId, item);
    }
  }

  const entries: TimelineEntry[] = [];
  const push = (entry: TimelineEntry) => {
    const last = entries.at(-1);
    if (
      entry.kind === "notice" &&
      last?.kind === "notice" &&
      sameNotice(last.item, entry.item)
    ) {
      entries[entries.length - 1] = { ...entry, count: last.count + 1 };
      return;
    }
    entries.push(entry);
  };

  for (const item of items) {
    switch (item.kind) {
      case "user_message":
        push({ kind: "user", id: item.id, item });
        break;
      case "agent_message":
        push({ kind: "message", id: item.id, item });
        break;
      case "reasoning":
        push({ kind: "reasoning", id: item.id, item });
        break;
      case "tool_call": {
        const row = { item, permission: permissions.get(item.id) ?? null };
        const last = entries.at(-1);
        // A call that created media stands on its own, so a group does not
        // hide what it made in an open turn or at the live edge (`08` R2).
        if (
          last?.kind === "tools" &&
          !createsMedia(item) &&
          !last.rows.some((previous) => createsMedia(previous.item))
        ) {
          entries[entries.length - 1] = { ...last, rows: [...last.rows, row] };
        } else {
          push({ kind: "tools", id: item.id, rows: [row] });
        }
        break;
      }
      case "plan":
        push({ kind: "plan", id: item.id, item });
        break;
      case "interaction":
        if (item.toolCallId && permissions.get(item.toolCallId) === item) break;
        if (item.request === "question") {
          push({ kind: "question", id: item.id, item });
        } else {
          push({ kind: "notice", id: item.id, item, count: 1 });
        }
        break;
      case "error":
      case "generic":
      case "mode_change":
      case "config_change":
        push({ kind: "notice", id: item.id, item, count: 1 });
        break;
      case "turn_outcome":
        if (item.reason !== "end_turn") {
          push({ kind: "outcome", id: item.id, item });
        }
        break;
      case "interrupted":
        push({ kind: "outcome", id: item.id, item });
        break;
    }
  }
  return entries;
}

function sameNotice(left: NoticeItem, right: NoticeItem): boolean {
  if (left.kind !== right.kind || left.summary !== right.summary) return false;
  if (left.kind === "generic" && right.kind === "generic") {
    return left.label === right.label;
  }
  return left.kind !== "interaction";
}

/** A turn result that leaves the turn failed: shown outside the fold. */
function isFailure(entry: TimelineEntry): boolean {
  if (entry.kind !== "outcome") return false;
  return entry.item.kind !== "turn_outcome" || entry.item.reason === "error";
}

function summarize(
  entries: TimelineEntry[],
  items: AgentActivityItemDto[],
): TurnSummary | null {
  const visible = new Set<string>();
  const user = entries.find((entry) => entry.kind === "user");
  if (user) visible.add(user.id);
  const lastMessage = lastWhere(entries, (entry) => entry.kind === "message");
  if (lastMessage) visible.add(lastMessage.id);
  const failure = lastWhere(entries, isFailure);
  if (failure) {
    visible.add(failure.id);
    // The error that failed the turn stays next to its marker.
    const error = lastWhere(
      entries.slice(0, entries.indexOf(failure)),
      (entry) => entry.kind === "notice" && entry.item.kind === "error",
    );
    if (error) visible.add(error.id);
  }
  const folded = entries.filter((entry) => !visible.has(entry.id));
  const count = folded.reduce(
    (sum, entry) => sum + (entry.kind === "tools" ? entry.rows.length : 1),
    0,
  );
  if (count === 0) return null;
  const outcome = lastWhere(
    items,
    (item) => item.kind === "turn_outcome" || item.kind === "interrupted",
  );
  return {
    visibleIds: visible,
    count,
    durationMs:
      outcome?.kind === "turn_outcome" || outcome?.kind === "interrupted"
        ? outcome.durationMs
        : null,
    afterId: user?.id ?? null,
  };
}

export function lastWhere<T>(
  values: readonly T[],
  matches: (value: T) => boolean,
): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (matches(values[index])) return values[index];
  }
  return undefined;
}

/** The tool call item a permission request is for, by its id. */
export function toolCallOf(
  snapshot: Pick<AgentSessionSnapshotDto, "items">,
  toolCallId: string | null,
): ItemOf<"tool_call"> | null {
  if (!toolCallId) return null;
  const item = snapshot.items.find((known) => known.id === toolCallId);
  return item?.kind === "tool_call" ? item : null;
}
