import {
  openAgentSessionActivity,
  type AgentActivitySubscription,
} from "../../api/activity";
import type { AgentSessionKeyDto, AgentSessionSnapshotDto } from "./chat";

interface SessionActivityState {
  snapshot: AgentSessionSnapshotDto | null;
  error: unknown;
}

export const EMPTY_ACTIVITY: SessionActivityState = { snapshot: null, error: null };

export interface SessionActivity {
  getSnapshot: () => SessionActivityState;
  subscribe: (listener: () => void) => () => void;
  refresh: (keepSnapshot?: boolean) => void;
}

/** A chat and an in-flight send can keep following the same runtime activity. */
export function createSessionActivity(session: AgentSessionKeyDto): SessionActivity {
  const listeners = new Set<() => void>();
  let current = EMPTY_ACTIVITY;
  let subscription: AgentActivitySubscription | null = null;

  const publish = (next: SessionActivityState) => {
    current = next;
    for (const listener of listeners) listener();
  };

  const start = () => {
    subscription = openAgentSessionActivity(
      session,
      (snapshot) => publish({ snapshot, error: null }),
      (error) => publish({ snapshot: null, error }),
    );
  };

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (!subscription) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        subscription?.close();
        subscription = null;
        current = EMPTY_ACTIVITY;
      };
    },
    refresh(keepSnapshot = false) {
      if (!subscription || current === EMPTY_ACTIVITY) return;
      subscription.close();
      if (!keepSnapshot) publish(EMPTY_ACTIVITY);
      start();
    },
  };
}
