import {
  listAgentSessions as listAgentSessionsCommand,
  reenterAgentSession as reenterAgentSessionCommand,
  refreshAgentSessions as refreshAgentSessionsCommand,
  setAgentSessionPinned as setAgentSessionPinnedCommand,
} from "@/platform/agent-sessions/agent-sessions-api";
import { openProjectInTool } from "@/platform/project-openers";
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

export function openSessionCwdInExternalTerminal(cwd: string) {
  return openProjectInTool(cwd, "terminal");
}

export function revealSessionFile(path: string) {
  return openPath(path);
}
