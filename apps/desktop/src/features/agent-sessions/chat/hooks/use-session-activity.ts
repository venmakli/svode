import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSessionActivity, EMPTY_ACTIVITY } from "../api/session-activity";
import type { AgentSessionKeyDto } from "../api/chat";

const empty = () => EMPTY_ACTIVITY;
const noopSubscribe = () => () => undefined;

/**
 * Live activity of a session: a snapshot, then its deltas. A gap in
 * delivery or an explicit reopen starts again from a runtime snapshot.
 */
export function useSessionActivity(session: AgentSessionKeyDto | null, epoch = 0) {
  const agent = session?.agent;
  const namespace = session?.namespace;
  const sessionId = session?.sessionId;
  const activity = useMemo(
    () => agent && namespace && sessionId
      ? createSessionActivity({ agent, namespace, sessionId })
      : null,
    [agent, namespace, sessionId],
  );
  const state = useSyncExternalStore(
    activity?.subscribe ?? noopSubscribe,
    activity?.getSnapshot ?? empty,
  );
  const followed = useRef({ activity, epoch });
  useLayoutEffect(() => {
    if (followed.current.activity === activity && followed.current.epoch !== epoch) {
      activity?.refresh();
    }
    followed.current = { activity, epoch };
  }, [activity, epoch]);
  return { ...state, activity };
}
