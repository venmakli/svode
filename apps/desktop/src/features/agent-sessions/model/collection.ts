import { isAgentTurnActive, requiresUserAction } from "./status";
import type { AgentSession } from "./types";

/** Default collection order: waiting, then working, then by last activity. */
export function compareAgentSessionsByDefault(
  left: AgentSession,
  right: AgentSession,
): number {
  return (
    workPriority(left) - workPriority(right) ||
    timestampMs(right.lastActivityAt) - timestampMs(left.lastActivityAt) ||
    left.id.localeCompare(right.id)
  );
}

function workPriority(session: AgentSession): number {
  if (requiresUserAction(session)) return 0;
  if (isAgentTurnActive(session)) return 1;
  return 2;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
