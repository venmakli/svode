import { expect, test } from "bun:test";
import type {
  AgentActivityItemDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { projectTimeline } from "./timeline";
import {
  activeTurnRailIndex,
  adjacentTurnRailIndex,
  turnRailEntries,
  turnRailTicks,
} from "./turn-rail";

function item(
  id: string,
  turnId: string | null,
  kind: Record<string, unknown>,
  summary = "",
): AgentActivityItemDto {
  return {
    id,
    turnId,
    status: "completed",
    summary,
    hasDetail: false,
    ...kind,
  } as AgentActivityItemDto;
}

const user = (id: string, turnId: string, text: string) =>
  item(id, turnId, { kind: "user_message", segments: [] }, text);
const reply = (id: string, turnId: string, text: string) =>
  item(id, turnId, { kind: "agent_message", media: [] }, text);
const ended = (id: string, turnId: string, reason: string) =>
  item(id, turnId, { kind: "turn_outcome", reason, durationMs: 10 });
const tool = (
  id: string,
  turnId: string,
  extra: Record<string, unknown>,
): AgentActivityItemDto =>
  item(id, turnId, {
    kind: "tool_call",
    tool: "other",
    media: [],
    locations: [],
    mcpCalls: [],
    ...extra,
  });

function timeline(items: AgentActivityItemDto[], live: string | null = null) {
  return projectTimeline({
    items,
    turn: {
      turnId: live,
      phase: live ? "running" : "none",
      lastOutcome: null,
      status: {
        state: "running",
        source: "svode_runtime",
        confidence: "exact",
      },
    },
  } as Pick<AgentSessionSnapshotDto, "items" | "turn">);
}

test("an entry per user's message with its first line, reply start and state", () => {
  const entries = turnRailEntries(
    timeline(
      [
        item("n0", null, { kind: "generic", label: "x" }),
        user("u1", "t1", "\n  Fix the  build\nand the tests"),
        reply("m1", "t1", "Looking"),
        reply("m2", "t1", "## Done\nAll green"),
        ended("o1", "t1", "end_turn"),
        user("u2", "t2", "Stop it"),
        ended("o2", "t2", "cancelled"),
        user("u3", "t3", "Broken"),
        reply("m3", "t3", "Partial"),
        ended("o3", "t3", "error"),
        user("u4", "t4", "Gone"),
        item("i4", "t4", { kind: "interrupted", durationMs: null }),
        user("u5", "t5", "Now"),
        reply("m5", "t5", "Working"),
      ],
      "t5",
    ),
  );
  expect(
    entries.map(({ messageId, title, reply, state }) => ({
      messageId,
      title,
      reply,
      state,
    })),
  ).toEqual([
    { messageId: "u1", title: "Fix the build", reply: "Done", state: "done" },
    { messageId: "u2", title: "Stop it", reply: null, state: "stopped" },
    { messageId: "u3", title: "Broken", reply: "Partial", state: "failed" },
    { messageId: "u4", title: "Gone", reply: null, state: "failed" },
    { messageId: "u5", title: "Now", reply: "Working", state: "live" },
  ]);
});

test("badges count media the turn created and files it changed", () => {
  const [first, second] = turnRailEntries(
    timeline([
      user("u1", "t1", "Draw"),
      tool("g1", "t1", {
        media: [
          { id: "a", kind: "image", path: "/x/a.png", hasData: false },
          { id: "b", kind: "image", path: "/x/b.png", hasData: false },
        ],
      }),
      tool("r1", "t1", {
        tool: "read",
        media: [{ id: "c", kind: "image", path: "/x/c.png", hasData: false }],
      }),
      reply("m1", "t1", "Here"),
      ended("o1", "t1", "end_turn"),
      user("u2", "t2", "Edit"),
      tool("e1", "t2", {
        tool: "edit",
        locations: [
          { path: "/p/a.md", change: "modified", lines: null },
          { path: "/p/b.md", change: "created", lines: null },
        ],
      }),
      reply("m2", "t2", "Edited"),
      ended("o2", "t2", "end_turn"),
    ]),
  );
  expect([first.createdMedia, first.changedFiles]).toEqual([2, 0]);
  expect([second.createdMedia, second.changedFiles]).toEqual([0, 2]);
});

test("all turns get a tick up to twenty", () => {
  expect(turnRailTicks(2, 1)).toEqual([0, 1]);
  expect(turnRailTicks(20, 7)).toEqual(Array.from({ length: 20 }, (_, i) => i));
});

test("twenty of more turns are taken at equal intervals from first to last", () => {
  const ticks = turnRailTicks(39, 0);
  expect(ticks.length).toBe(20);
  expect(ticks).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  const many = turnRailTicks(1000, 999);
  expect(many.length).toBe(20);
  expect(many[0]).toBe(0);
  expect(many.at(-1)).toBe(999);
  expect(new Set(many).size).toBe(20);
  expect(many).toEqual([...many].sort((a, b) => a - b));
});

test("the active turn is always a tick in place of the nearest taken one", () => {
  // 39 turns: ticks at even indices; the active 7 replaces 6 (the nearer of 6 and 8 first).
  const ticks = turnRailTicks(39, 7);
  expect(ticks.length).toBe(20);
  expect(ticks.includes(7)).toBe(true);
  expect(ticks.includes(6)).toBe(false);
  expect(ticks.includes(8)).toBe(true);
  expect(ticks).toEqual([...ticks].sort((a, b) => a - b));

  for (const count of [21, 30, 57, 120]) {
    for (let active = 0; active < count; active += 1) {
      const sampled = turnRailTicks(count, active);
      expect(sampled.length).toBe(20);
      expect(sampled.includes(active)).toBe(true);
      expect(new Set(sampled).size).toBe(20);
      expect(sampled).toEqual([...sampled].sort((a, b) => a - b));
    }
  }
});

test("the active turn is the one whose message last passed the top, else the first", () => {
  const entries = [
    { messageId: "u1" },
    { messageId: "u2" },
    { messageId: "u3" },
  ];
  expect(activeTurnRailIndex(entries, "u2")).toBe(1);
  expect(activeTurnRailIndex(entries, null)).toBe(0);
  expect(activeTurnRailIndex(entries, "other")).toBe(0);
  expect(activeTurnRailIndex([], null)).toBe(-1);
});

test("a step moves one turn and stops at either end", () => {
  expect(adjacentTurnRailIndex(5, 2, -1)).toBe(1);
  expect(adjacentTurnRailIndex(5, 2, 1)).toBe(3);
  expect(adjacentTurnRailIndex(5, 0, -1)).toBe(null);
  expect(adjacentTurnRailIndex(5, 4, 1)).toBe(null);
  expect(adjacentTurnRailIndex(0, -1, 1)).toBe(null);
});
