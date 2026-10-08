import type {
  AgentActivityItemDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import * as m from "@/paraglide/messages.js";
import { fileName } from "./attachments";

type ToolCallItem = Extract<AgentActivityItemDto, { kind: "tool_call" }>;

/**
 * What the agent does now in a running turn (`08`, R6): by the last active
 * item of the turn, never its arguments, directories or command text.
 */
export type LiveTurnActivity =
  | { kind: "stopping" }
  | { kind: "waiting" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "command"; program: string | null }
  | { kind: "reading"; name: string | null }
  | { kind: "editing"; name: string | null }
  | { kind: "searching" }
  | { kind: "fetching"; domain: string | null }
  | { kind: "calling"; tool: string }
  | { kind: "actions"; count: number }
  | { kind: "working" };

/** The activity of the running turn; null between turns. */
export function liveTurnActivity(
  snapshot: Pick<AgentSessionSnapshotDto, "items" | "turn" | "pending">,
): LiveTurnActivity | null {
  const { turn } = snapshot;
  if (turn.phase === "none") return null;
  if (turn.phase === "cancelling") return { kind: "stopping" };
  if (snapshot.pending) return { kind: "waiting" };

  const items = snapshot.items.filter(
    (item) => turn.turnId !== null && item.turnId === turn.turnId,
  );
  const last = items.at(-1);
  if (last?.kind === "agent_message") return { kind: "writing" };
  if (last?.kind === "reasoning") return { kind: "thinking" };

  // Tool calls after the agent's last text: those still running are what
  // it does now; a call without a status counts while it is the last item.
  let start = items.length;
  while (
    start > 0 &&
    items[start - 1].kind !== "agent_message" &&
    items[start - 1].kind !== "reasoning"
  ) {
    start -= 1;
  }
  const active = items
    .slice(start)
    .filter(
      (item): item is ToolCallItem =>
        item.kind === "tool_call" &&
        (item.status === "pending" ||
          item.status === "in_progress" ||
          (item.status === null && item === last)),
    );
  if (active.length > 1) return { kind: "actions", count: active.length };
  if (active.length === 1) return toolActivity(active[0]);
  return { kind: "working" };
}

function toolActivity(item: ToolCallItem): LiveTurnActivity {
  // An MCP call recognized by the form of its agent, whatever its kind.
  const call = item.mcpCalls.at(-1);
  if (call) return { kind: "calling", tool: call.tool };
  switch (item.tool) {
    case "execute":
      return { kind: "command", program: commandProgram(item.summary) };
    case "read":
      return { kind: "reading", name: locationName(item) };
    case "edit":
    case "delete":
    case "move":
      return { kind: "editing", name: locationName(item) };
    case "search":
      return { kind: "searching" };
    case "fetch":
      return { kind: "fetching", domain: urlDomain(item.summary) };
    default:
      return { kind: "working" };
  }
}

/** The file name of the call's first location, without its directories. */
function locationName(item: ToolCallItem): string | null {
  const path = item.locations[0]?.path;
  return path ? fileName(path) : null;
}

const PROGRAM = /^[\w.+-]+$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * The first program of a command in the title forms of Codex
 * (`Run <command>`) and Claude Code (`` `<command>` ``, cut short with the
 * title); any other title is not a command line, and gives no program.
 */
export function commandProgram(summary: string): string | null {
  const text = summary.trim();
  const command =
    /^`([^`]+)`?$/.exec(text)?.[1] ?? /^Run\s+`?([^`]+)`?$/.exec(text)?.[1];
  if (!command) return null;
  const word = command
    .trim()
    .split(/\s+/)
    .find((token) => !ASSIGNMENT.test(token));
  const program = word
    ?.replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .at(-1);
  return program && PROGRAM.test(program) ? program : null;
}

/** The host of the first `http(s)` address in a title. */
export function urlDomain(summary: string): string | null {
  const url = /https?:\/\/[^\s`'"<>()]+/i.exec(summary)?.[0];
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The one-line caption of the running turn's marker. */
export function liveTurnCaption(activity: LiveTurnActivity): string {
  switch (activity.kind) {
    case "stopping":
      return m.sessions_chat_live_stopping();
    case "waiting":
      return m.sessions_chat_live_waiting();
    case "thinking":
      return m.sessions_chat_live_thinking();
    case "writing":
      return m.sessions_chat_live_writing();
    case "command":
      return activity.program
        ? m.sessions_chat_live_running_program({ program: activity.program })
        : m.sessions_chat_live_running_command();
    case "reading":
      return activity.name
        ? m.sessions_chat_live_reading_file({ name: activity.name })
        : m.sessions_chat_live_reading();
    case "editing":
      return activity.name
        ? m.sessions_chat_live_editing_file({ name: activity.name })
        : m.sessions_chat_live_editing();
    case "searching":
      return m.sessions_chat_live_searching();
    case "fetching":
      return activity.domain
        ? m.sessions_chat_live_fetching_domain({ domain: activity.domain })
        : m.sessions_chat_live_fetching();
    case "calling":
      return m.sessions_chat_live_calling({ tool: activity.tool });
    case "actions":
      return m.sessions_chat_live_actions({ count: activity.count });
    case "working":
      return m.sessions_chat_live_working();
  }
}
