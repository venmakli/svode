import { expect, test } from "bun:test";
import type {
  AgentActivityItemDto,
  AgentTurnStateDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { activitySnapshot } from "../../model/testing/activity";
import { applyAgentActivityMessage } from "../../model/activity";
import { isExpanded, shownEntries, summaryKey } from "./expansion";
import { projectTimeline } from "./timeline";

type Kind = AgentActivityItemDto extends infer T
  ? T extends { kind: infer K }
    ? K
    : never
  : never;

function item(
  id: string,
  turnId: string | null,
  kind: Partial<AgentActivityItemDto> & { kind: Kind },
  summary = "",
): AgentActivityItemDto {
  return {
    id,
    turnId,
    status: null,
    summary,
    hasDetail: false,
    ...kind,
  } as AgentActivityItemDto;
}

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

const running: AgentTurnStateDto = {
  ...idle,
  turnId: "t2",
  phase: "running",
  lastOutcome: null,
  status: { state: "running", source: "svode_runtime", confidence: "exact" },
};

function tool(id: string, turnId: string, status = "completed") {
  return item(
    id,
    turnId,
    { kind: "tool_call", tool: "execute", status } as never,
    `run ${id}`,
  );
}

test("a turn keeps its order, groups consecutive tool calls and shows one plan", () => {
  const timeline = projectTimeline({
    turn: idle,
    items: [
      item("user:t1", "t1", { kind: "user_message" }, "Fix it"),
      item("m1", "t1", { kind: "agent_message" }, "Looking"),
      tool("a", "t1"),
      tool("b", "t1"),
      item("plan:t1", "t1", {
        kind: "plan",
        entries: [{ content: "Step", priority: "high", status: "completed" }],
      }),
      item("g1", "t1", { kind: "generic", label: "future_update" }),
      item("m2", "t1", { kind: "agent_message" }, "Done"),
      item("usage", "t1", { kind: "usage" }, "10/100"),
      item("outcome:t1", "t1", {
        kind: "turn_outcome",
        reason: "end_turn",
        durationMs: 4200,
      }),
    ],
  });

  expect(timeline.length).toBe(1);
  const [turn] = timeline;
  expect(turn.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
    "user:user:t1",
    "message:m1",
    "tools:a",
    "plan:plan:t1",
    "notice:g1",
    "message:m2",
  ]);
  const tools = turn.entries[2];
  expect(tools.kind === "tools" && tools.rows.map((row) => row.item.id)).toEqual(
    ["a", "b"],
  );
});

test("a finished turn folds into a summary row with the last answer outside", () => {
  const [turn] = projectTimeline({
    turn: idle,
    items: [
      item("user:t1", "t1", { kind: "user_message" }, "Fix it"),
      item("r1", "t1", { kind: "reasoning" }, "thinking"),
      tool("a", "t1"),
      tool("b", "t1"),
      item("m1", "t1", { kind: "agent_message" }, "Interim"),
      item("m2", "t1", { kind: "agent_message" }, "Final"),
      item("outcome:t1", "t1", {
        kind: "turn_outcome",
        reason: "end_turn",
        durationMs: 61_000,
      }),
    ],
  });

  expect(turn.summary?.count).toBe(4);
  expect(turn.summary?.durationMs).toBe(61_000);
  expect(turn.summary?.afterId).toBe("user:t1");
  expect(shownEntries({}, turn).map((entry) => entry.id)).toEqual([
    "user:t1",
    "m2",
  ]);
  // Folding is presentation only; opening it shows the whole turn.
  expect(
    shownEntries({ [summaryKey(turn)]: true }, turn).map((entry) => entry.id),
  ).toEqual(["user:t1", "r1", "a", "m1", "m2"]);
});

test("a failed turn keeps its error and marker outside the fold", () => {
  const [turn] = projectTimeline({
    turn: { ...idle, lastOutcome: "interrupted" },
    items: [
      item("user:t1", "t1", { kind: "user_message" }, "Go"),
      tool("a", "t1", "failed"),
      item("e1", "t1", { kind: "error" }, "connection reset by peer"),
      item("outcome:t1", "t1", { kind: "interrupted", durationMs: 1000 }),
    ],
  });

  expect(shownEntries({}, turn).map((entry) => entry.id)).toEqual([
    "user:t1",
    "e1",
    "outcome:t1",
  ]);
  expect(turn.summary?.count).toBe(1);
  const error = turn.entries.find((entry) => entry.id === "e1")!;
  expect(isExpanded({}, turn, error)).toBe(true);
});

test("a turn without folded items and a live turn get no summary row", () => {
  const timeline = projectTimeline({
    turn: running,
    items: [
      item("user:t1", "t1", { kind: "user_message" }, "Hi"),
      item("m1", "t1", { kind: "agent_message" }, "Hello"),
      item("user:t2", "t2", { kind: "user_message" }, "Work"),
      tool("a", "t2", "in_progress"),
    ],
  });
  expect(timeline.map((turn) => turn.summary)).toEqual([null, null]);
  expect(timeline[1].live).toBe(true);
});

test("the live edge opens by itself and a manual choice outranks it", () => {
  const items = [
    item("user:t2", "t2", { kind: "user_message" }, "Work"),
    item("r1", "t2", { kind: "reasoning" }, "thinking"),
    tool("a", "t2", "in_progress"),
  ];
  const [live] = projectTimeline({ turn: running, items });
  const reasoning = live.entries[1];
  const tools = live.entries[2];
  expect(isExpanded({}, live, reasoning)).toBe(false);
  expect(isExpanded({}, live, tools)).toBe(true);
  expect(isExpanded({ a: false }, live, tools)).toBe(false);

  // The turn moved on: the group folds unless the user opened it.
  const [later] = projectTimeline({
    turn: running,
    items: [...items, item("m1", "t2", { kind: "agent_message" }, "Done")],
  });
  expect(isExpanded({}, later, later.entries[2])).toBe(false);
  expect(isExpanded({ a: true }, later, later.entries[2])).toBe(true);
});

test("repeats of a service record in a row collapse into the last with a count", () => {
  const [turn] = projectTimeline({
    turn: running,
    items: [
      item("user:t2", "t2", { kind: "user_message" }, "Go"),
      item("e1", "t2", { kind: "error" }, "Reconnecting"),
      item("e2", "t2", { kind: "error" }, "Reconnecting"),
      item("e3", "t2", { kind: "error" }, "Reconnecting"),
      item("e4", "t2", { kind: "error" }, "Failed for good"),
    ],
  });
  expect(
    turn.entries.map((entry) =>
      entry.kind === "notice" ? `${entry.id}x${entry.count}` : entry.id,
    ),
  ).toEqual(["user:t2", "e3x3", "e4x1"]);
});

test("a permission outcome joins its tool row and a question stays its own record", () => {
  const [turn] = projectTimeline({
    turn: running,
    items: [
      item("user:t2", "t2", { kind: "user_message" }, "Go"),
      tool("call", "t2"),
      item(
        "interaction:1",
        "t2",
        {
          kind: "interaction",
          request: "permission",
          state: "answered",
          toolCallId: "call",
          option: "Allow",
          declined: false,
        },
        "Run npm test",
      ),
      item(
        "interaction:2",
        "t2",
        {
          kind: "interaction",
          request: "question",
          state: "expired",
          toolCallId: null,
          option: null,
          declined: false,
        },
        "Which branch?",
      ),
    ],
  });
  expect(turn.entries.map((entry) => entry.kind)).toEqual([
    "user",
    "tools",
    "question",
  ]);
  const tools = turn.entries[1];
  expect(tools.kind === "tools" && tools.rows[0].permission?.option).toBe(
    "Allow",
  );
});

test("each prefix of a stream projects like the deltas applied up to it", () => {
  const items = [
    item("user:t2", "t2", { kind: "user_message" }, "Go"),
    tool("a", "t2", "pending"),
    { ...tool("a", "t2", "completed"), summary: "run a (done)" },
    item("m1", "t2", { kind: "agent_message" }, "Hel"),
    item("m1", "t2", { kind: "agent_message" }, "Hello"),
  ];
  let state = activitySnapshot({ turn: running });
  const reference = activitySnapshot({ turn: running });
  items.forEach((next, index) => {
    const step = applyAgentActivityMessage(state, {
      type: "delta",
      value: { seq: index + 1, change: "item", value: next },
    });
    if (step.kind !== "state") throw new Error("expected a state");
    state = step.state;
    const at = reference.items.findIndex((known) => known.id === next.id);
    if (at === -1) reference.items.push(next);
    else reference.items[at] = next;
    expect(projectTimeline(state)).toEqual(projectTimeline(reference));
  });
  const [turn] = projectTimeline(state);
  expect(turn.entries.map((entry) => entry.id)).toEqual(["user:t2", "a", "m1"]);
});
