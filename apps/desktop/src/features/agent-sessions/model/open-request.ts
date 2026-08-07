import type { AgentSession, AgentSessionOpenRequest } from "./types";

export function findAgentSessionForOpenRequest(
  sessions: readonly AgentSession[],
  request: AgentSessionOpenRequest,
) {
  const launchMatches = sessions.filter(
    (session) => session.launchId === request.launchId,
  );
  const canonical = launchMatches.find(
    (session) => session.runtime?.provisional !== true,
  );
  if (canonical) return canonical;
  return (
    sessions.find((session) => session.id === request.sessionId) ??
    launchMatches[0] ??
    null
  );
}
