import type { AgentSessionsListResult } from "../api";
import {
  agentSessionHasId,
  agentSessionTargetFor,
  resolveAgentSessionId,
  type AgentSessionTarget,
} from "./target";
import type { AgentSession } from "./types";

/** The pty id of the session's live Svode terminal, if it has one. */
export function liveTerminalPtyId(
  session: AgentSession,
): string | undefined {
  return session.runtime?.live ? session.runtime.ptyId : undefined;
}

/**
 * Sessions whose live Svode terminal the read-model now lists at another
 * session, by the id of the session that had it: the agent CLI in that
 * terminal went on to another session (DF-163 R3). A provisional launch
 * that becomes canonical is not a move; its launch id carries it.
 */
export function agentSessionTerminalMoves(
  previous: readonly AgentSession[],
  next: readonly AgentSession[],
): Map<string, AgentSession> {
  const nextByPtyId = new Map<string, AgentSession>();
  for (const session of next) {
    const ptyId = liveTerminalPtyId(session);
    if (ptyId) nextByPtyId.set(ptyId, session);
  }

  const moves = new Map<string, AgentSession>();
  for (const from of previous) {
    const ptyId = liveTerminalPtyId(from);
    const to = ptyId ? nextByPtyId.get(ptyId) : undefined;
    if (!to || agentSessionHasId(to, from.id)) continue;
    if (from.runtime?.provisional === true) continue;
    if (from.launchId && from.launchId === to.launchId) continue;
    moves.set(from.id, to);
  }
  return moves;
}

/** What the catalog knew when a session terminal moved, and what it knows now. */
export interface AgentSessionTerminalFollowState {
  result: AgentSessionsListResult | null;
  sessions: AgentSession[];
  pendingHandoffs: Record<string, string>;
}

/**
 * How a surface follows the terminals that moved between two catalog
 * states, or null when none did. A surface showing a session with its live
 * terminal goes on to the session the terminal moved to (DF-163 R4); every
 * other target, including one opened on the previous session after the
 * move, gets null and stays.
 */
export function agentSessionTerminalFollow(
  previous: AgentSessionTerminalFollowState,
  next: Pick<AgentSessionTerminalFollowState, "result">,
): ((target: AgentSessionTarget) => AgentSessionTarget | null) | null {
  if (previous.result === next.result) return null;
  const moves = agentSessionTerminalMoves(
    previous.result?.sessions ?? [],
    next.result?.sessions ?? [],
  );
  if (moves.size === 0) return null;
  return (target) => {
    const sessionId = resolveAgentSessionId(
      target,
      previous.sessions,
      previous.pendingHandoffs,
    );
    const to = moves.get(sessionId);
    return to ? agentSessionTargetFor(to) : null;
  };
}
