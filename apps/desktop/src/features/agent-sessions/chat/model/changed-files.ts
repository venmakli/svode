import type {
  AgentActivityItemDto,
  AgentToolLocationDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { fileName } from "./attachments";
import type { TimelineTurn } from "./timeline";

type ToolCallItem = Extract<AgentActivityItemDto, { kind: "tool_call" }>;

export type FileChangeKind = NonNullable<AgentToolLocationDto["change"]>;

export interface LineCounts {
  added: number;
  removed: number;
}

/** A file a finished turn changed, as its tool calls named it. */
export interface ChangedFile {
  /** Absolute path. */
  path: string;
  name: string;
  change: FileChangeKind | null;
  /** Lines the turn's diffs of the file change; null without a diff. */
  lines: LineCounts | null;
  /** The tool calls whose diffs make the file's diff of the turn, in order. */
  diffCalls: ToolCallItem[];
}

export interface TurnChanges {
  files: ChangedFile[];
  /** The sum over files with a diff; null when no file has one. */
  lines: LineCounts | null;
}

const CHANGING_KINDS = new Set(["edit", "delete", "move"]);

/**
 * The files a finished turn changed (Stage 10 `08` R2): the locations and
 * diff paths of its edit, delete and move tool calls and the paths of its
 * Svode MCP calls that change the project, without repeats, in order of
 * first appearance. A failed call changed nothing. Null for a live turn and
 * a turn without changes.
 */
export function turnChanges(turn: TimelineTurn): TurnChanges | null {
  if (turn.live) return null;
  const files: ChangedFile[] = [];
  for (const entry of turn.entries) {
    if (entry.kind !== "tools") continue;
    for (const { item } of entry.rows) {
      if (item.status === "failed" || !changesFiles(item)) continue;
      for (const location of item.locations) {
        add(files, item, location);
      }
    }
  }
  if (files.length === 0) return null;
  const counted = files.filter((file) => file.lines);
  return {
    files,
    lines:
      counted.length > 0
        ? {
            added: sum(counted, (file) => file.lines?.added ?? 0),
            removed: sum(counted, (file) => file.lines?.removed ?? 0),
          }
        : null,
  };
}

function changesFiles(item: ToolCallItem): boolean {
  return (
    CHANGING_KINDS.has(item.tool) ||
    item.mcpCalls.some((call) => call.changesProject)
  );
}

function add(
  files: ChangedFile[],
  item: ToolCallItem,
  location: AgentToolLocationDto,
) {
  let file = files.find((known) => known.path === location.path);
  if (!file) {
    file = {
      path: location.path,
      name: fileName(location.path),
      change: null,
      lines: null,
      diffCalls: [],
    };
    files.push(file);
  }
  // A file the turn created stays created through its later edits.
  if (
    location.change &&
    !(file.change === "created" && location.change === "modified")
  ) {
    file.change = location.change;
  }
  if (location.lines) {
    file.lines = {
      added: (file.lines?.added ?? 0) + location.lines.added,
      removed: (file.lines?.removed ?? 0) + location.lines.removed,
    };
    file.diffCalls.push(item);
  }
}

function sum<T>(values: T[], of: (value: T) => number): number {
  return values.reduce((total, value) => total + of(value), 0);
}
