import { expect, test } from "bun:test";
import type {
  AgentActivityMessageDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { activitySnapshot } from "../model/testing/activity";
import {
  openAgentSessionActivity,
  type AgentActivityTransport,
} from "./activity";

const session = {
  agent: "codex",
  namespace: "native",
  sessionId: "s1",
} as const;

/** A runtime delivery driven by the test. */
function fakeTransport() {
  const deliveries: ((message: AgentActivityMessageDto) => void)[] = [];
  const unsubscribed: number[] = [];
  let failNext: unknown = null;
  const transport: AgentActivityTransport = {
    subscribe: (_, onMessage) => {
      if (failNext) {
        const error = failNext;
        failNext = null;
        return Promise.reject(error);
      }
      deliveries.push(onMessage);
      return Promise.resolve(deliveries.length);
    },
    unsubscribe: (subscription) => {
      unsubscribed.push(subscription);
      return Promise.resolve();
    },
  };
  return {
    transport,
    deliveries,
    unsubscribed,
    failNextSubscribe: (error: unknown) => {
      failNext = error;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const connection = (seq: number) =>
  ({
    type: "delta",
    value: { seq, change: "connection", value: "degraded" },
  }) as const;

test("follows the snapshot and consecutive deltas", () => {
  const { transport, deliveries } = fakeTransport();
  const states: AgentSessionSnapshotDto[] = [];
  openAgentSessionActivity(
    session,
    (state) => states.push(state),
    () => {},
    transport,
  );

  deliveries[0]({ type: "snapshot", value: activitySnapshot({ seq: 2 }) });
  deliveries[0](connection(3));
  deliveries[0](connection(3));

  expect(states.map((state) => state.seq)).toEqual([2, 3]);
  expect(deliveries.length).toBe(1);
});

test("a seq gap drops the delivery and starts again from a new snapshot", async () => {
  const { transport, deliveries, unsubscribed } = fakeTransport();
  const states: AgentSessionSnapshotDto[] = [];
  openAgentSessionActivity(
    session,
    (state) => states.push(state),
    () => {},
    transport,
  );

  deliveries[0]({ type: "snapshot", value: activitySnapshot({ seq: 2 }) });
  deliveries[0](connection(5));
  await settle();

  expect(deliveries.length).toBe(2);
  expect(unsubscribed).toEqual([1]);
  deliveries[0](connection(6));
  deliveries[1]({ type: "snapshot", value: activitySnapshot({ seq: 5 }) });
  expect(states.map((state) => state.seq)).toEqual([2, 5]);
});

test("close stops the delivery and ignores late messages", async () => {
  const { transport, deliveries, unsubscribed } = fakeTransport();
  const states: AgentSessionSnapshotDto[] = [];
  const activity = openAgentSessionActivity(
    session,
    (state) => states.push(state),
    () => {},
    transport,
  );

  activity.close();
  deliveries[0]({ type: "snapshot", value: activitySnapshot() });
  await settle();

  expect(states).toEqual([]);
  expect(unsubscribed).toEqual([1]);
});

test("a refused subscription reports its error", async () => {
  const { transport, failNextSubscribe } = fakeTransport();
  const refusal = { kind: "agent_runtime", code: "session_not_found" };
  failNextSubscribe(refusal);
  const errors: unknown[] = [];
  openAgentSessionActivity(
    session,
    () => {},
    (error) => errors.push(error),
    transport,
  );
  await settle();

  expect(errors).toEqual([refusal]);
});
