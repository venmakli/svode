import {
  holdAgentSessionCatalog as holdAgentSessionCatalogCommand,
  hotStatusAgentSessions as hotStatusAgentSessionsCommand,
  listAgentSessions as listAgentSessionsCommand,
  listSavedAgentSessions as listSavedAgentSessionsCommand,
  raiseAgentSessionCatalog as raiseAgentSessionCatalogCommand,
  reenterAgentSession as reenterAgentSessionCommand,
  refreshAgentSessions as refreshAgentSessionsCommand,
  releaseAgentSessionCatalog,
} from "@/platform/agent-sessions/agent-sessions-api";
import {
  listProjectOpeners,
  openProjectInApp,
  type ExternalAppDto,
} from "@/platform/project-openers";

export type {
  AgentResumeCommand,
  AgentSession,
  AgentSessionCapabilities,
  AgentSessionReentryError,
  AgentSessionReentryErrorCode,
  AgentSessionReentryMode,
  AgentSessionReentryResult,
  AgentSessionsHotStatusResult,
  AgentSessionsListResult,
  AgentSessionsListStatus,
  AgentSessionSource,
  AgentSessionSourceReport,
  AgentSessionStatus,
} from "@/platform/agent-sessions/agent-sessions-api";

export function listAgentSessions(projectPath: string) {
  return listAgentSessionsCommand(projectPath);
}

export function listSavedAgentSessions(projectPath: string) {
  return listSavedAgentSessionsCommand(projectPath);
}

export function refreshAgentSessions(projectPath: string) {
  return refreshAgentSessionsCommand(projectPath);
}

export function raiseAgentSessionCatalog() {
  return raiseAgentSessionCatalogCommand();
}

/**
 * Keeps the catalogue connections of an open Sessions collection; the
 * returned release ends the hold, also when it is still being granted.
 */
export function holdAgentSessionCatalog(): () => void {
  const hold = holdAgentSessionCatalogCommand();
  hold.catch((error: unknown) => {
    console.error("Failed to hold the session catalogue:", error);
  });
  return () => {
    void hold.then((id) => releaseAgentSessionCatalog(id)).catch(() => {});
  };
}

export function hotStatusAgentSessions(
  projectPath: string,
  sessionIds: string[],
) {
  return hotStatusAgentSessionsCommand(projectPath, sessionIds);
}

export function reenterAgentSession(projectPath: string, sessionId: string) {
  return reenterAgentSessionCommand(projectPath, sessionId);
}

const EXTERNAL_TERMINAL_APP_ID = "terminal";

/** Opens a session cwd in an installed terminal, the system one by default. */
export function openSessionCwdInExternalTerminal(
  cwd: string,
  appId: string = EXTERNAL_TERMINAL_APP_ID,
) {
  return openProjectInApp(cwd, appId);
}

/** The installed terminals of the external application catalog. */
export async function listExternalTerminalApps(): Promise<ExternalAppDto[]> {
  const apps = await listProjectOpeners();
  return apps.filter((app) => app.kind === "terminal");
}

/** The installed terminal that opens a session cwd, when available. */
export async function loadExternalTerminalApp(): Promise<ExternalAppDto | null> {
  const apps = await listProjectOpeners();
  return apps.find((app) => app.id === EXTERNAL_TERMINAL_APP_ID) ?? null;
}
