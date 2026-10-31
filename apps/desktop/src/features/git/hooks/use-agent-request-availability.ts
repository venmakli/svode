import { useEffect, useState } from "react";
import { agentRequests, type AgentRequestPlace } from "../model/agent-request";

/**
 * Whether a chat session can take a request for `place` now, read while
 * `enabled`: true or false once known, null while unknown.
 */
export function useAgentRequestAvailability(
  place: AgentRequestPlace,
  enabled: boolean,
): boolean | null {
  const { spacePath, sessionId = null } = place;
  const key = `${spacePath}\0${sessionId ?? ""}`;
  const [state, setState] = useState<{ key: string; available: boolean } | null>(
    null,
  );
  const requests = agentRequests();
  useEffect(() => {
    if (!enabled || !requests) return;
    let current = true;
    requests.available({ spacePath, sessionId }).then(
      (available) => {
        if (current) setState({ key, available });
      },
      () => {
        if (current) setState({ key, available: false });
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, key, requests, sessionId, spacePath]);
  if (!requests) return false;
  return state?.key === key ? state.available : null;
}
