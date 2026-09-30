import { isAgentTurnActive, requiresUserAction } from "./status";
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

/** Waiting, then working, then with an open terminal; latest activity first. */
export function compareActiveAgentSessions(
  left: AgentSession,
  right: AgentSession,
): number {
  const priorityDelta = activePriority(right) - activePriority(left);
  if (priorityDelta !== 0) return priorityDelta;

  return activityMs(right) - activityMs(left);
}

/** The active sessions in their Now order. */
export function activeAgentSessions(
  sessions: readonly AgentSession[],
): AgentSession[] {
  return sessions.filter(isActiveAgentSession).sort(compareActiveAgentSessions);
}

function activePriority(session: AgentSession): number {
  if (requiresUserAction(session)) return 3;
  if (isAgentTurnActive(session)) return 2;
  if (session.runtime?.ptyId) return 1;
  return 0;
}

function activityMs(session: AgentSession): number {
  if (!isAgentTurnActive(session) && session.runtime?.ptyId) {
    return timestampMs(terminalActivityAt(session) ?? session.lastActivityAt);
  }

  return timestampMs(session.lastActivityAt);
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
