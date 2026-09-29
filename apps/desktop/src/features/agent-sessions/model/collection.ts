import { hasActionableWait, terminalActivityAt } from "./grouping";
import type { AgentSession } from "./types";

/** Last activity as the collection shows it: terminal activity while one is open. */
export function agentSessionLastActivityAt(session: AgentSession): string {
  if (!session.runtime?.ptyId) return session.lastActivityAt;
  return terminalActivityAt(session) ?? session.lastActivityAt;
}

/** Default collection order: waiting, then working, then by last activity. */
export function compareAgentSessionsByDefault(
  left: AgentSession,
  right: AgentSession,
): number {
  return (
    workPriority(left) - workPriority(right) ||
    timestampMs(agentSessionLastActivityAt(right)) -
      timestampMs(agentSessionLastActivityAt(left)) ||
    left.id.localeCompare(right.id)
  );
}

function workPriority(session: AgentSession): number {
  if (hasActionableWait(session)) return 0;
  if (session.status === "active") return 1;
  return 2;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
