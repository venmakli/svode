import { useEffect, useState } from "react";
import { openAgentSessionActivity } from "../../api/activity";
import type { AgentSessionKeyDto, AgentSessionSnapshotDto } from "../api/chat";

export interface SessionActivity {
  snapshot: AgentSessionSnapshotDto | null;
  /** The runtime does not serve the session, e.g. it is no longer open. */
  error: unknown;
}

/**
 * The live activity of a session the runtime drives: a snapshot, then its
 * deltas. A reload or a seq gap starts again from a new snapshot.
 */
export function useSessionActivity(
  session: AgentSessionKeyDto | null,
  /** A new value subscribes again, as after the session was attached anew. */
  epoch = 0,
): SessionActivity {
  const key = session
    ? `${session.agent}\n${session.namespace}\n${session.sessionId}\n${epoch}`
    : null;
  const [state, setState] = useState<SessionActivity & { key: string | null }>(
    { key: null, snapshot: null, error: null },
  );
  useEffect(() => {
    if (!session || !key) return;
    const subscription = openAgentSessionActivity(
      session,
      (snapshot) => setState({ key, snapshot, error: null }),
      (error) => setState({ key, snapshot: null, error }),
    );
    return () => subscription.close();
    // The key names the session; the object identity does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key
    ? { snapshot: state.snapshot, error: state.error }
    : { snapshot: null, error: null };
}
