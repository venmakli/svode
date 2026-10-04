import type { AgentSession } from "@/platform/agent-sessions/agent-sessions-api";
import type { TerminalTab, TerminalTarget } from "./types";

/**
 * Links panel tabs to the live sessions of the catalog: a tab whose PTY a
 * session runs in, or that was just recognized as one, shows that session.
 * Session terminals opened outside the panel get no tab.
 */
export function applyAgentSessionsToTabs(
  tabs: TerminalTab[],
  sessions: AgentSession[],
  linkedByTabId: ReadonlyMap<string, AgentSession>,
): TerminalTab[] {
  const liveByPtyId = new Map<string, AgentSession>();
  for (const session of sessions) {
    const ptyId = session.runtime?.live ? session.runtime.ptyId : undefined;
    if (ptyId) liveByPtyId.set(ptyId, session);
  }

  return tabs.map((tab) => {
    const session =
      (tab.ptyId ? liveByPtyId.get(tab.ptyId) : undefined) ??
      linkedByTabId.get(tab.id);
    return session ? linkAgentSessionToTab(tab, session) : tab;
  });
}

function linkAgentSessionToTab(
  tab: TerminalTab,
  session: AgentSession,
): TerminalTab {
  return {
    ...tab,
    title: agentSessionTabTitle(session),
    agentSessionId: session.id,
  };
}

export function findMatchingAgentSessionForShellTab(
  tab: TerminalTab,
  sessions: AgentSession[],
  usedSessionIds: Set<string> = new Set(),
): AgentSession | null {
  if (tab.agentSessionId || !tab.ptyId) return null;

  const openedAtMs = timestampMs(tab.createdAt);
  const candidates = sessions
    .filter((session) => {
      if (usedSessionIds.has(session.id)) return false;
      if (session.runtime?.ptyId && session.runtime.ptyId !== tab.ptyId) {
        return false;
      }
      if (!sessionMatchesTabCwd(session, tab)) return false;
      if (!sessionActivityAfterTabOpen(session, openedAtMs)) return false;
      return true;
    })
    .sort(
      (left, right) =>
        timestampMs(right.lastActivityAt) - timestampMs(left.lastActivityAt),
    );

  return candidates[0] ?? null;
}

export function targetToShellTab(
  id: string,
  target: TerminalTarget,
  createdAt: string,
): TerminalTab {
  return {
    id,
    title: target.name,
    cwd: target.path,
    scope: target.scope,
    scopeId: target.scopeId,
    ptyId: null,
    status: "spawning",
    error: null,
    createdAt,
  };
}

function agentSessionTabTitle(session: AgentSession): string {
  return session.title.trim() || session.sourceSessionId || session.id;
}

function sessionMatchesTabCwd(
  session: AgentSession,
  tab: TerminalTab,
): boolean {
  const sessionCwd = session.resumeCommand?.cwd ?? session.cwd;
  if (sessionCwd) return samePath(sessionCwd, tab.cwd);

  if (session.scopeKind !== tab.scope) return false;
  if (session.scopeKind === "space") {
    return (
      session.spaceId === tab.scopeId ||
      samePath(session.spacePath, tab.cwd) ||
      samePath(session.projectPath, tab.cwd)
    );
  }

  return samePath(session.projectPath, tab.cwd);
}

function sessionActivityAfterTabOpen(
  session: AgentSession,
  openedAtMs: number,
): boolean {
  if (!Number.isFinite(openedAtMs)) return true;
  const startedAtMs = timestampMs(session.startedAt);
  if (Number.isFinite(startedAtMs)) return startedAtMs >= openedAtMs - 5_000;

  const activityMs = timestampMs(session.lastActivityAt);
  if (!Number.isFinite(activityMs)) return false;
  return activityMs >= openedAtMs - 5_000;
}

function timestampMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function samePath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}
