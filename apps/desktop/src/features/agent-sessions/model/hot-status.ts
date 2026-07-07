import { isPendingSessionId } from "./pending";
import type { AgentSession } from "./types";

export function buildHotStatusSessionIds({
  sessions,
  selectedSessionId,
}: {
  sessions: AgentSession[];
  selectedSessionId: string | null;
}): string[] {
  const ids = new Set<string>();

  for (const session of sessions) {
    if (!isHotStatusCandidate(session)) continue;
    ids.add(session.id);
  }

  const selected = sessions.find((session) => session.id === selectedSessionId);
  if (selected && isRefreshableSourceSession(selected)) {
    ids.add(selected.id);
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
