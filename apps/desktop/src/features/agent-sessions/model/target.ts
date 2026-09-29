import type { AgentSession } from "./types";

/**
 * The identity every entry point addresses a session by: its catalog id when
 * opened, plus the launch id that survives a provisional → canonical handoff.
 */
export interface AgentSessionTarget {
  sessionId: string;
  launchId: string | null;
}

/**
 * The catalog id a target currently resolves to. A pending terminal follows
 * the CLI session matched to its pty, and a provisional launch follows the
 * canonical session that carries the same launch id.
 */
export function resolveAgentSessionId(
  target: AgentSessionTarget,
  sessions: readonly AgentSession[],
  pendingHandoffs: Readonly<Record<string, string>>,
): string {
  const sessionId = pendingHandoffs[target.sessionId] ?? target.sessionId;
  const listed = sessions.find((session) => session.id === sessionId);
  if (!target.launchId || (listed && listed.runtime?.provisional !== true)) {
    return sessionId;
  }
  const canonical = sessions.find(
    (session) =>
      session.launchId === target.launchId &&
      session.runtime?.provisional !== true,
  );
  return canonical?.id ?? sessionId;
}

export function agentSessionTargetFor(
  session: AgentSession,
): AgentSessionTarget {
  return { sessionId: session.id, launchId: session.launchId ?? null };
}
