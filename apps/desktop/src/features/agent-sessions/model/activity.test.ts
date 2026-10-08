import { expect, test } from "bun:test";
import type { AgentPendingInteractionDto } from "@/platform/agent-runtime/agent-runtime-api";
import { applyAgentActivityMessage } from "./activity";
import { activitySnapshot } from "./testing/activity";

function permission(
  state: AgentPendingInteractionDto["state"],
): AgentPendingInteractionDto {
  return {
    id: "interaction:1",
    kind: "permission",
    title: "touch probe.txt",
    toolCallId: "call_1",
    options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    fields: [],
    state,
  };
}

function stateOf(step: ReturnType<typeof applyAgentActivityMessage>) {
  if (step.kind !== "state")
    throw new Error(`expected state, got ${step.kind}`);
  return step.state;
}

test("a snapshot replaces the local state, so a reload has no duplicates", () => {
  const stale = activitySnapshot({
    seq: 3,
    items: [
      {
        kind: "user_message",
        segments: [],
        id: "user:t1",
        turnId: "t1",
        status: null,
        summary: "hi",
        hasDetail: false,
      },
    ],
    pending: permission("pending"),
  });
  const fresh = activitySnapshot({ seq: 9, items: stale.items });

  const state = stateOf(
    applyAgentActivityMessage(stale, { type: "snapshot", value: fresh }),
  );

  expect(state.items.length).toBe(1);
  expect(state.pending).toBeNull();
});

test("deltas upsert items by id and a resolved request clears pending", () => {
  let state = activitySnapshot();
  const item = {
    kind: "tool_call" as const,
    tool: "execute" as const,
    media: [],
    id: "call-1",
    turnId: "t1",
    status: "in_progress" as const,
    summary: "touch",
    hasDetail: false,
  };
  state = stateOf(
    applyAgentActivityMessage(state, {
      type: "delta",
      value: { seq: 1, change: "item", value: item },
    }),
  );
  state = stateOf(
    applyAgentActivityMessage(state, {
      type: "delta",
      value: {
        seq: 2,
        change: "item",
        value: { ...item, status: "completed" },
      },
    }),
  );
  state = stateOf(
    applyAgentActivityMessage(state, {
      type: "delta",
      value: { seq: 3, change: "pending", value: permission("pending") },
    }),
  );
  expect(state.pending?.id).toBe("interaction:1");
  state = stateOf(
    applyAgentActivityMessage(state, {
      type: "delta",
      value: { seq: 4, change: "pending", value: permission("answered") },
    }),
  );

  expect(state.seq).toBe(4);
  expect(state.items).toEqual([{ ...item, status: "completed" }]);
  expect(state.pending).toBeNull();
});

test("a duplicate delta changes nothing and a seq gap resubscribes", () => {
  const state = activitySnapshot({ seq: 5 });
  const delta = (seq: number) =>
    ({
      type: "delta",
      value: { seq, change: "connection", value: "degraded" },
    }) as const;

  expect(applyAgentActivityMessage(state, delta(5)).kind).toBe("unchanged");
  expect(applyAgentActivityMessage(state, delta(7)).kind).toBe("resubscribe");
  expect(applyAgentActivityMessage(null, delta(1)).kind).toBe("resubscribe");
  expect(stateOf(applyAgentActivityMessage(state, delta(6))).connection).toBe(
    "degraded",
  );
});

test("a truncation drops the evicted items and marks the history", () => {
  const message = (id: string, turnId: string) => ({
    kind: "user_message" as const,
    segments: [],
    id,
    turnId,
    status: null,
    summary: id,
    hasDetail: false,
  });
  const state = stateOf(
    applyAgentActivityMessage(
      activitySnapshot({
        seq: 4,
        items: [message("a", "replay:1"), message("b", "replay:2")],
      }),
      {
        type: "delta",
        value: {
          seq: 5,
          change: "truncated",
          value: {
            itemIds: ["a"],
            history: { source: "replay", available: true, truncatedItems: 1 },
          },
        },
      },
    ),
  );

  expect(state.items.map((item) => item.id)).toEqual(["b"]);
  expect(state.history.truncatedItems).toBe(1);
});

test("a settings delta replaces the session settings", () => {
  const mode = {
    id: "mode",
    name: "Approval Preset",
    description: null,
    category: "mode" as const,
    currentValue: "workspace-write",
    options: [
      { value: "workspace-write", name: "Default", description: null },
      { value: "agent", name: "Auto review", description: null },
    ],
  };

  const state = stateOf(
    applyAgentActivityMessage(activitySnapshot(), {
      type: "delta",
      value: { seq: 1, change: "settings", value: [mode] },
    }),
  );

  expect(state.settings).toEqual([mode]);
  expect(state.seq).toBe(1);
});
