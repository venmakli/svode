import { expect, test } from "bun:test";
import type {
  AgentActivityItemDto,
  AgentToolLocationDto,
  AgentTurnStateDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { turnChanges } from "./changed-files";
import { projectTimeline } from "./timeline";

const idle: AgentTurnStateDto = {
  turnId: "t1",
  phase: "none",
  lastOutcome: "end_turn",
  status: {
    state: "idle",
    stopReason: "end_turn",
    source: "svode_runtime",
    confidence: "exact",
  },
};

function tool(
  id: string,
  kind: string,
  locations: AgentToolLocationDto[],
  options: { status?: string; mcp?: boolean; turnId?: string } = {},
): AgentActivityItemDto {
  return {
    id,
    turnId: options.turnId ?? "t1",
    kind: "tool_call",
    tool: kind,
    media: [],
    locations,
    mcpCalls: options.mcp
      ? [{ server: "svode", tool: "create_page", changesProject: true }]
      : [],
    status: options.status ?? "completed",
    summary: id,
    hasDetail: true,
  } as AgentActivityItemDto;
}

function message(id: string, turnId = "t1"): AgentActivityItemDto {
  return {
    id,
    turnId,
    kind: "agent_message",
    media: [],
    status: null,
    summary: "Done",
    hasDetail: false,
  };
}

const at = (
  path: string,
  change: AgentToolLocationDto["change"],
  lines: AgentToolLocationDto["lines"] = null,
): AgentToolLocationDto => ({ path, change, lines });

test("a finished turn lists its changed files once, in order, with the lines of its diffs", () => {
  const [turn] = projectTimeline({
    turn: idle,
    items: [
      tool("read", "read", [at("/p/seen.md", null)]),
      tool("e1", "edit", [at("/p/a.md", "modified", { added: 2, removed: 1 })]),
      tool("mcp", "execute", [at("/p/notes/B.md", "created")], { mcp: true }),
      tool("failed", "edit", [at("/p/never.md", null)], { status: "failed" }),
      tool("e2", "edit", [at("/p/a.md", "modified", { added: 1, removed: 0 })]),
      tool("rm", "delete", [at("/p/old.md", "deleted")]),
      message("m1"),
    ],
  });
  const changes = turnChanges(turn);
  expect(changes?.files.map((file) => [file.name, file.change])).toEqual([
    ["a.md", "modified"],
    ["B.md", "created"],
    ["old.md", "deleted"],
  ]);
  const [edited, created] = changes!.files;
  expect(edited.lines).toEqual({ added: 3, removed: 1 });
  expect(edited.diffCalls.map((item) => item.id)).toEqual(["e1", "e2"]);
  expect(created.lines).toBeNull();
  expect(created.diffCalls).toEqual([]);
  expect(changes?.lines).toEqual({ added: 3, removed: 1 });
});

test("a live turn, a turn without changes and a file without a diff", () => {
  const items = [tool("e1", "edit", [at("/p/a.md", null)]), message("m1")];
  expect(
    turnChanges(
      projectTimeline({
        turn: { ...idle, phase: "running", lastOutcome: null },
        items,
      })[0],
    ),
  ).toBeNull();
  expect(
    turnChanges(
      projectTimeline({
        turn: idle,
        items: [tool("r", "read", [at("/p/a.md", null)]), message("m1")],
      })[0],
    ),
  ).toBeNull();
  const changes = turnChanges(projectTimeline({ turn: idle, items })[0]);
  expect(changes?.files?.length).toBe(1);
  expect(changes?.lines).toBeNull();
});

test("a file the turn created stays created through its later edits", () => {
  const [turn] = projectTimeline({
    turn: idle,
    items: [
      tool("w", "edit", [at("/p/n.md", "created", { added: 1, removed: 0 })]),
      tool("e", "edit", [at("/p/n.md", "modified", { added: 1, removed: 1 })]),
    ],
  });
  expect(turnChanges(turn)?.files[0].change).toBe("created");
});
