import { isPendingSessionId } from "./pending";
import type { AgentSession } from "./types";

export function buildHotStatusSessionIds({
  sessions,
  observedSessionIds,
}: {
  sessions: AgentSession[];
  observedSessionIds: Iterable<string>;
}): string[] {
  const ids = new Set<string>();

  for (const session of sessions) {
    if (!isHotStatusCandidate(session)) continue;
    ids.add(session.id);
  }

  const observed = new Set(observedSessionIds);
  for (const session of sessions) {
    if (observed.has(session.id) && isRefreshableSourceSession(session)) {
      ids.add(session.id);
    }
  }

  return Array.from(ids);
}

function isHotStatusCandidate(session: AgentSession): boolean {
  return (
    isRefreshableSourceSession(session) &&
    (session.status === "active" ||
      Boolean(session.activeFlags?.length) ||
      Boolean(session.runtime?.ptyId))
  );
}

function isRefreshableSourceSession(session: AgentSession): boolean {
  return !isPendingSessionId(session.id) && session.source !== "unknown";
}
