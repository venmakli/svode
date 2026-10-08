import { turnChanges } from "./changed-files";
import { turnCreatedMediaCount } from "./media";
import { lastWhere, type TimelineTurn } from "./timeline";

/** At most this many ticks, whatever the number of turns (`08` R4). */
export const TURN_RAIL_TICKS = 20;

/**
 * How a turn ended, as the rail marks it: `failed` covers an error and an
 * interrupted turn, `stopped` a turn the user cancelled.
 */
export type TurnRailState = "live" | "done" | "stopped" | "failed";

/** One entry of the turn rail: a user's message of the loaded history. */
export interface TurnRailEntry {
  /** The user's message: the target of navigation. */
  messageId: string;
  turnId: string;
  /** The first line of the user's message. */
  title: string;
  /** The start of the agent's last message in the turn. */
  reply: string | null;
  state: TurnRailState;
  createdMedia: number;
  changedFiles: number;
}

/**
 * The turn rail of a timeline (Stage 10 `08` R4): an entry per user's
 * message in order, with the state, reply and badges of its turn.
 */
export function turnRailEntries(
  turns: readonly TimelineTurn[],
): TurnRailEntry[] {
  const entries: TurnRailEntry[] = [];
  for (const turn of turns) {
    const users = turn.entries.flatMap((entry) =>
      entry.kind === "user" ? [entry] : [],
    );
    if (users.length === 0) continue;
    const last = lastWhere(turn.entries, (entry) => entry.kind === "message");
    const reply =
      last?.kind === "message" ? leadingText(last.item.summary) || null : null;
    const state = turnState(turn);
    const createdMedia = turnCreatedMediaCount(turn);
    const changedFiles = turnChanges(turn)?.files.length ?? 0;
    for (const user of users) {
      entries.push({
        messageId: user.id,
        turnId: turn.id,
        title: leadingText(user.item.summary),
        reply,
        state,
        createdMedia,
        changedFiles,
      });
    }
  }
  return entries;
}

function turnState(turn: TimelineTurn): TurnRailState {
  if (turn.live) return "live";
  const outcome = lastWhere(turn.entries, (entry) => entry.kind === "outcome");
  if (outcome?.kind !== "outcome") return "done";
  if (outcome.item.kind === "interrupted") return "failed";
  if (outcome.item.reason === "error") return "failed";
  if (outcome.item.reason === "cancelled") return "stopped";
  return "done";
}

/** The first non-empty line of a text, without leading markdown marks. */
function leadingText(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .trim();
    if (trimmed) return trimmed.replace(/\s+/g, " ");
  }
  return "";
}

/**
 * The active entry: the one whose user's message last passed the top of the
 * visible area — the scroller's current anchor — or the first one before
 * any did. -1 without entries.
 */
export function activeTurnRailIndex(
  entries: readonly Pick<TurnRailEntry, "messageId">[],
  anchorId: string | null,
): number {
  if (entries.length === 0) return -1;
  if (anchorId === null) return 0;
  const index = entries.findIndex((entry) => entry.messageId === anchorId);
  return index === -1 ? 0 : index;
}

/**
 * The entries the rail shows a tick for, by index in order: all of them up
 * to `limit`; beyond it, entries taken at equal intervals from the first to
 * the last, with the active one always shown in place of the nearest taken.
 */
export function turnRailTicks(
  count: number,
  active: number,
  limit: number = TURN_RAIL_TICKS,
): number[] {
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (limit - 1);
  const ticks = Array.from({ length: limit }, (_, index) =>
    Math.round(index * step),
  );
  if (active < 0 || active >= count || ticks.includes(active)) return ticks;
  let nearest = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    if (Math.abs(ticks[index] - active) < Math.abs(ticks[nearest] - active)) {
      nearest = index;
    }
  }
  ticks[nearest] = active;
  return ticks;
}

/** The entry one step from the active one, or null past either end. */
export function adjacentTurnRailIndex(
  count: number,
  active: number,
  step: -1 | 1,
): number | null {
  if (count === 0) return null;
  const next = Math.max(active, 0) + step;
  return next >= 0 && next < count ? next : null;
}
