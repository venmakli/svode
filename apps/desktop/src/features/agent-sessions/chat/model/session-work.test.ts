import { expect, test } from "bun:test";
import type { ChangesTarget } from "@/features/changes";
import type {
  AgentActivityItemDto,
  AgentToolLocationDto,
  AgentTurnStateDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { sessionChangesTarget, sessionWorkFiles } from "./session-work";
import { projectTimeline } from "./timeline";

const idle: AgentTurnStateDto = {
  turnId: "t2",
  phase: "none",
  lastOutcome: "end_turn",
  status: {
    state: "idle",
    stopReason: "end_turn",
    source: "svode_runtime",
    confidence: "exact",
  },
};

function edit(
  id: string,
  turnId: string | null,
  paths: string[],
  status = "completed",
): AgentActivityItemDto {
  return {
    id,
    turnId,
    kind: "tool_call",
    tool: "edit",
    media: [],
    locations: paths.map(
      (path): AgentToolLocationDto => ({
        path,
        change: "modified",
        lines: null,
      }),
    ),
    mcpCalls: [],
    status,
    summary: id,
    hasDetail: false,
  } as AgentActivityItemDto;
}

const items = (turnIds: [string | null, string | null]) => [
  edit("a", turnIds[0], ["/p/docs/a.md", "/p/docs/b.md"]),
  edit("b", turnIds[1], ["/p/docs/b.md", "/p/space/c.md"]),
  edit("c", turnIds[1], ["/p/docs/never.md"], "failed"),
];

test("the work of a session joins the changed files of all its turns once", () => {
  const turns = projectTimeline({ turn: idle, items: items(["t1", "t2"]) });
  expect(sessionWorkFiles(turns)).toEqual([
    "/p/docs/a.md",
    "/p/docs/b.md",
    "/p/space/c.md",
  ]);
});

test("a replayed session without turn ids has the same work", () => {
  const live = sessionWorkFiles(
    projectTimeline({ turn: idle, items: items(["t1", "t2"]) }),
  );
  const replayed = sessionWorkFiles(
    projectTimeline({
      turn: { ...idle, turnId: null },
      items: items([null, null]),
    }),
  );
  expect(replayed).toEqual(live);
});

test("a live turn adds nothing until it ends", () => {
  const turns = projectTimeline({
    turn: { ...idle, phase: "running", lastOutcome: null },
    items: [edit("a", "t2", ["/p/docs/a.md"])],
  });
  expect(sessionWorkFiles(turns)).toEqual([]);
});

const space: ChangesTarget = {
  kind: "space",
  sourceShape: "directory",
  spacePath: "/p/docs",
  projectPath: "/p",
  path: "",
  name: "Docs",
};
const spaces = [
  { id: "root", path: "/p" },
  { id: "docs", path: "/p/docs" },
  { id: "space", path: "/p/space" },
];

test("a terminal session, without work, keeps the area of its Space", () => {
  expect(sessionChangesTarget(space, null, spaces)).toBe(space);
});

test("a chat session's area holds its files in project Spaces only", () => {
  const target = sessionChangesTarget(
    space,
    ["/p/docs/a.md", "/p/space/c.md", "/tmp/outside.md"],
    spaces,
  );
  expect(target.kind).toBe("session");
  expect(target.work).toEqual({
    spaceKind: "space",
    files: [
      { spaceId: "docs", spacePath: "/p/docs", path: "a.md" },
      { spaceId: "space", spacePath: "/p/space", path: "c.md" },
    ],
  });
  expect(
    sessionChangesTarget({ ...space, kind: "project" }, [], spaces).work
      ?.spaceKind,
  ).toBe("project");
});
