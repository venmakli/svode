import {
  hotStatusAgentSessions as hotStatusAgentSessionsCommand,
  listAgentSessions as listAgentSessionsCommand,
  reenterAgentSession as reenterAgentSessionCommand,
  refreshAgentSessions as refreshAgentSessionsCommand,
  setAgentSessionPinned as setAgentSessionPinnedCommand,
} from "@/platform/agent-sessions/agent-sessions-api";
import {
  listProjectOpeners,
  openProjectInApp,
  type ExternalAppDto,
} from "@/platform/project-openers";
import { openPath } from "@/platform/native/shell";

export type {
  AgentResumeCommand,
  AgentSession,
  AgentSessionActiveFlag,
  AgentSessionCapabilities,
  AgentSessionCounts,
  AgentSessionFileRef,
  AgentSessionReentryError,
  AgentSessionReentryErrorCode,
  AgentSessionReentryMode,
  AgentSessionReentryResult,
  AgentSessionsHotStatusResult,
  AgentSessionsListResult,
  AgentSessionsListStatus,
  AgentSessionsPinResult,
  AgentSessionSource,
  AgentSessionSourceReport,
  AgentSessionStatus,
} from "@/platform/agent-sessions/agent-sessions-api";

export function listAgentSessions(projectPath: string) {
  return listAgentSessionsCommand(projectPath);
}

export function refreshAgentSessions(projectPath: string) {
  return refreshAgentSessionsCommand(projectPath);
}

export function hotStatusAgentSessions(
  projectPath: string,
  sessionIds: string[],
) {
  return hotStatusAgentSessionsCommand(projectPath, sessionIds);
}

export function setAgentSessionPinned(
  projectPath: string,
  sessionId: string,
  pinned: boolean,
) {
  return setAgentSessionPinnedCommand(projectPath, sessionId, pinned);
}

export function reenterAgentSession(projectPath: string, sessionId: string) {
  return reenterAgentSessionCommand(projectPath, sessionId);
}

const EXTERNAL_TERMINAL_APP_ID = "terminal";

export function openSessionCwdInExternalTerminal(cwd: string) {
  return openProjectInApp(cwd, EXTERNAL_TERMINAL_APP_ID);
}

/** The installed terminal that opens a session cwd, when available. */
export async function loadExternalTerminalApp(): Promise<ExternalAppDto | null> {
  const apps = await listProjectOpeners();
  return apps.find((app) => app.id === EXTERNAL_TERMINAL_APP_ID) ?? null;
}

export function revealSessionFile(path: string) {
  return openPath(path);
}
