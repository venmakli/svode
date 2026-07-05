import type { AgentSession } from "@/features/terminal/api/agent-sessions";
import type {
  TerminalAgentSurface,
  TerminalTab,
  TerminalTarget,
} from "./types";

export function isLiveAgentTerminalSession(session: AgentSession): boolean {
  return Boolean(session.runtime?.live && session.runtime.ptyId);
}

export function terminalTabIdForAgentSession(
  session: AgentSession,
  ptyId: string,
): string {
  return `agent-session:${session.id}:${ptyId}`;
}

export function terminalTabFromAgentSession(
  session: AgentSession,
  projectPath: string,
  existing?: TerminalTab,
): TerminalTab | null {
  const ptyId = session.runtime?.ptyId;
  if (!ptyId) return null;

  const cwd = session.resumeCommand?.cwd ?? session.cwd ?? projectPath;
  return {
    id: existing?.id ?? terminalTabIdForAgentSession(session, ptyId),
    title: agentSessionTabTitle(session),
    cwd,
    scope: session.scopeKind,
    scopeId:
      session.scopeKind === "space"
        ? (session.spaceId ?? session.spacePath ?? session.id)
        : (session.projectId ?? session.projectPath ?? projectPath),
    ptyId,
    status: existing?.status === "error" ? existing.status : "ready",
    error: existing?.status === "error" ? existing.error : null,
    origin: "agent-session",
    createdAt:
      existing?.createdAt ??
      session.runtime?.lastInputAt ??
      session.runtime?.lastOutputAt ??
      session.startedAt ??
      session.lastActivityAt,
    agentSessionId: session.id,
    agentSessionSource: session.source,
    agentSourceSessionId: session.sourceSessionId,
  };
}

export function terminalTabFromAgentSurface(
  surface: TerminalAgentSurface,
  existing?: TerminalTab,
): TerminalTab {
  return {
    id: existing?.id ?? terminalTabIdForAgentSurface(surface),
    title: agentSurfaceTabTitle(surface),
    cwd: surface.shellCwd,
    scope: existing?.scope ?? "project",
    scopeId: existing?.scopeId ?? surface.agentSessionId,
    ptyId: surface.ptyId,
    status: existing?.status === "error" ? existing.status : "ready",
    error: existing?.status === "error" ? existing.error : null,
    origin: "agent-session",
    createdAt: existing?.createdAt ?? surface.createdAt,
    agentSessionId: surface.agentSessionId,
    agentSessionSource: surface.source,
    agentSourceSessionId: surface.sourceSessionId,
  };
}

export function syncTabsWithAgentSurfaces(
  tabs: TerminalTab[],
  surfaces: TerminalAgentSurface[],
): TerminalTab[] {
  const surfacesByPtyId = new Map(
    surfaces.map((surface) => [surface.ptyId, surface]),
  );
  const usedPtyIds = new Set<string>();
  const nextTabs: TerminalTab[] = [];

  for (const tab of tabs) {
    const surface = tab.ptyId ? surfacesByPtyId.get(tab.ptyId) : undefined;
    if (surface) {
      if (usedPtyIds.has(surface.ptyId)) continue;
      nextTabs.push(terminalTabFromAgentSurface(surface, tab));
      usedPtyIds.add(surface.ptyId);
      continue;
    }

    if (tab.origin === "agent-session") continue;
    nextTabs.push(tab);
    if (tab.ptyId) usedPtyIds.add(tab.ptyId);
  }

  for (const surface of surfaces) {
    if (usedPtyIds.has(surface.ptyId)) continue;
    nextTabs.push(terminalTabFromAgentSurface(surface));
    usedPtyIds.add(surface.ptyId);
  }

  return nextTabs;
}

export function mergeAgentSessionIntoTab(
  tab: TerminalTab,
  session: AgentSession,
  projectPath: string,
): TerminalTab {
  return (
    terminalTabFromAgentSession(session, projectPath, tab) ?? {
      ...tab,
      title: agentSessionTabTitle(session),
      origin: "agent-session",
      agentSessionId: session.id,
      agentSessionSource: session.source,
      agentSourceSessionId: session.sourceSessionId,
    }
  );
}

export function findMatchingAgentSessionForShellTab(
  tab: TerminalTab,
  sessions: AgentSession[],
  usedSessionIds: Set<string> = new Set(),
): AgentSession | null {
  if (tab.origin !== "shell" || !tab.ptyId) return null;

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

export function terminalTabIdForAgentSurface(
  surface: TerminalAgentSurface,
): string {
  return `agent-session:${surface.agentSessionId}:${surface.ptyId}`;
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
    origin: "shell",
    createdAt,
  };
}

export function agentSessionTabTitle(session: AgentSession): string {
  return session.title.trim() || session.sourceSessionId || session.id;
}

export function agentSurfaceTabTitle(surface: TerminalAgentSurface): string {
  return (
    surface.title?.trim() || surface.sourceSessionId || surface.agentSessionId
  );
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
