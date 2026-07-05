import type { AgentSession, AgentSessionScopeGroup } from "./types";

export const NEW_SESSION_ID_PREFIX = "new-session:";

export interface PendingAgentSessionTerminal {
  id: string;
  ptyId: string;
  title: string;
  scope: AgentSessionScopeGroup;
  cwd: string;
  createdAt: string;
}

export interface LocalSessionTerminal {
  ptyId: string;
  cwd?: string;
  createdAt?: string;
}

export function pendingSessionId(ptyId: string): string {
  return `${NEW_SESSION_ID_PREFIX}${ptyId}`;
}

export function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(NEW_SESSION_ID_PREFIX);
}

export function buildPendingAgentSession(
  pending: PendingAgentSessionTerminal,
): AgentSession {
  const session: AgentSession = {
    id: pending.id,
    source: "unknown",
    sourceSessionId: pending.id,
    title: pending.title,
    titleSource: "session-id",
    status: "unknown",
    activeFlags: [],
    statusSource: "embedded-terminal",
    statusConfidence: "unknown",
    statusReason: "new managed shell waiting for a CLI agent session",
    runtime: {
      ptyId: pending.ptyId,
      live: true,
      lastInputAt: pending.createdAt,
    },
    scopeKind: pending.scope.kind,
    scopeStatus: pending.scope.status,
    scopeConfidence: "exact",
    cwd: pending.cwd,
    startedAt: pending.createdAt,
    lastActivityAt: pending.createdAt,
    capabilities: {
      canResume: false,
      canRevealFile: false,
      hasReadableLog: false,
    },
    pinned: false,
    sourceMeta: {
      historyPresent: false,
      detailPresent: false,
      sessionIndexPresent: false,
      detailFileCount: 0,
      historyLineCount: 0,
      detailLineCount: 0,
      malformedLineCount: 0,
      functionCallCount: 0,
      notes: ["new managed shell"],
    },
  };

  if (pending.scope.kind === "project") {
    session.projectPath = pending.scope.path;
  } else {
    session.spaceId = pending.scope.scopeId;
    session.spacePath = pending.scope.path;
  }

  return session;
}

export function applyLocalTerminalRuntime(
  session: AgentSession,
  terminal: LocalSessionTerminal | undefined,
): AgentSession {
  if (!terminal) return session;

  return {
    ...session,
    runtime: {
      ...session.runtime,
      ptyId: terminal.ptyId,
      live: true,
      lastInputAt:
        session.runtime?.lastInputAt ??
        terminal.createdAt ??
        session.lastActivityAt,
    },
  };
}

export function findMatchingSessionForPendingTerminal(
  pending: PendingAgentSessionTerminal,
  sessions: AgentSession[],
  usedSessionIds: Set<string> = new Set(),
): AgentSession | null {
  const createdAtMs = timestampMs(pending.createdAt);
  const candidates = sessions
    .filter((session) => {
      if (usedSessionIds.has(session.id)) return false;
      if (session.source === "unknown") return false;
      if (!sessionMatchesPendingScope(session, pending)) return false;
      if (!sessionActivityAfterPendingOpen(session, createdAtMs)) return false;
      return true;
    })
    .sort(
      (left, right) =>
        timestampMs(right.lastActivityAt) - timestampMs(left.lastActivityAt),
    );

  return candidates[0] ?? null;
}

function sessionMatchesPendingScope(
  session: AgentSession,
  pending: PendingAgentSessionTerminal,
): boolean {
  const sessionCwd = session.resumeCommand?.cwd ?? session.cwd;
  if (sessionCwd) {
    return samePath(sessionCwd, pending.cwd);
  }

  if (pending.scope.kind !== session.scopeKind) return false;
  if (pending.scope.kind === "project") {
    return samePath(session.projectPath, pending.scope.path);
  }

  return (
    session.spaceId === pending.scope.scopeId ||
    samePath(session.spacePath, pending.scope.path)
  );
}

function sessionActivityAfterPendingOpen(
  session: AgentSession,
  createdAtMs: number,
): boolean {
  if (!Number.isFinite(createdAtMs)) return true;
  const activityMs = timestampMs(session.lastActivityAt);
  if (!Number.isFinite(activityMs)) return false;
  return activityMs >= createdAtMs - 5_000;
}

function timestampMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}
