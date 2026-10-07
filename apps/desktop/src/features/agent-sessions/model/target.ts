import type { AgentSession } from "./types";

/**
 * Whether a catalog id names the session: its own id or that of another
 * link of its conversation, such as a Hermes chain listed by its root.
 */
export function agentSessionHasId(session: AgentSession, id: string): boolean {
  return session.id === id || (session.aliasIds?.includes(id) ?? false);
}

/**
 * The identity every entry point addresses a session by: its catalog id when
 * opened, plus the launch id that survives a provisional → canonical handoff.
 */
export interface AgentSessionTarget {
  sessionId: string;
  launchId: string | null;
}

/**
 * A new session draft in a host: `draftId` tells one opening from the next,
 * `spacePath` is the Space of the context it was opened from.
 */
export interface NewSessionDraftTarget {
  draftId: string;
  spacePath: string;
}

/** How an entry point opens a session. */
export interface AgentSessionOpenOptions {
  /** The user asked for the terminal, e.g. by starting a new session. */
  focusTerminal?: boolean;
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
  const handedOff = pendingHandoffs[target.sessionId] ?? target.sessionId;
  const listed = sessions.find((session) =>
    agentSessionHasId(session, handedOff),
  );
  const sessionId = listed?.id ?? handedOff;
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
