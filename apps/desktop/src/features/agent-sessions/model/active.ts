import { isAgentTurnActive } from "./status";
import type { AgentSession } from "./types";

/**
 * An active session: it is working, waits for the user, or has a live Svode
 * terminal. Now lists every active session of the project.
 */
export function isActiveAgentSession(session: AgentSession): boolean {
  return isAgentTurnActive(session) || Boolean(session.runtime?.ptyId);
}

export function terminalActivityAt(session: AgentSession): string | undefined {
  const outputAt = session.runtime?.lastOutputAt;
  const inputAt = session.runtime?.lastInputAt;
  if (!outputAt) return inputAt;
  if (!inputAt) return outputAt;
  return timestampMs(outputAt) >= timestampMs(inputAt) ? outputAt : inputAt;
}

/**
 * The active sessions, in catalog order: where a session stands in Now is
 * up to Now, not its status (DF-206).
 */
export function activeAgentSessions(
  sessions: readonly AgentSession[],
): AgentSession[] {
  return sessions.filter(isActiveAgentSession);
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
