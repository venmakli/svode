import type {
  AgentSessionKeyDto,
  AgentSessionStatusDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { invokeCommand as invoke } from "@/platform/native/invoke";

/** The id of the session's agent in the registry. */
export type AgentSessionSource = string;
/** The one session status vocabulary of the agent runtime (Stage 10 C10). */
export type AgentSessionStatus = AgentSessionStatusDto;
export type AgentSessionTitleSource = "cli-title" | "session-id";
export type AgentSessionScopeKind = "project" | "space";
export type AgentSessionScopeStatus = "ready" | "missing" | "broken";
export type AgentSessionScopeConfidence = "exact" | "cwd-prefix";

export interface AgentSessionRuntime {
  ptyId?: string;
  pid?: number;
  live: boolean;
  provisional?: boolean;
  lastOutputAt?: string;
  lastInputAt?: string;
  /** The key a Svode ACP connection drives the session under. */
  acpSession?: AgentSessionKeyDto;
}

export interface AgentResumeCommand {
  display: string;
  program: string;
  args: string[];
  cwd?: string;
}

export interface AgentSessionCapabilities {
  canResume: boolean;
  /** The record carries the key the agent's runtime opens it under. */
  canOpenInChat: boolean;
}

export interface AgentSession {
  id: string;
  launchId?: string;
  routineRunId?: string;
  source: AgentSessionSource;
  sourceSessionId: string;
  title: string;
  titleSource: AgentSessionTitleSource;
  status: AgentSessionStatus;
  /** Evidence behind the status, or why sources contradict each other. */
  statusReason?: string;
  runtime?: AgentSessionRuntime;
  projectId?: string;
  projectPath?: string;
  scopeKind: AgentSessionScopeKind;
  scopeStatus: AgentSessionScopeStatus;
  spaceId?: string;
  spacePath?: string;
  scopeConfidence: AgentSessionScopeConfidence;
  cwd?: string;
  startedAt?: string;
  lastActivityAt: string;
  waitingSince?: string;
  resumeCommand?: AgentResumeCommand;
  capabilities: AgentSessionCapabilities;
}

export type AgentSessionsListStatus = "ok" | "partial";
/**
 * `stale-snapshot`: a list saved before the app started is shown until its
 * agent's connection opens; it confirms no session missing.
 */
export type AgentSessionsCacheMode = "current" | "stale-snapshot";
export type AgentSessionSourceReportStatus =
  | "ok"
  /** The last good list is shown; the agent did not answer the latest read. */
  | "stale";
export type AgentSessionDiagnosticSeverity = "info" | "warning";

export interface AgentSessionsListResult {
  status: AgentSessionsListStatus;
  generatedAt: string;
  projectPath: string;
  sessions: AgentSession[];
  sources: AgentSessionSourceReport[];
  summary: AgentSessionsListSummary;
  cache: AgentSessionsCacheState;
}

export interface AgentSessionsListSummary {
  returnedSessions: number;
  unresolvedCandidates: number;
  incompleteCandidates: number;
}

export interface AgentSessionsCacheState {
  mode: AgentSessionsCacheMode;
}

export interface AgentSessionsHotStatusResult {
  generatedAt: string;
  projectPath: string;
  sessions: AgentSession[];
  checkedSessions: number;
  updatedSessions: number;
  skippedSessions: number;
}

/** One agent's session list: its ACP `session/list`. */
export interface AgentSessionSourceReport {
  source: AgentSessionSource;
  status: AgentSessionSourceReportStatus;
  /** When the shown list was read. */
  readAt?: string;
  durationMs?: number;
  counts: AgentSessionSourceCounts;
  diagnostics: AgentSessionDiagnostic[];
}

export interface AgentSessionSourceCounts {
  recordsRead: number;
  candidates: number;
  returnedSessions: number;
  unresolvedCandidates: number;
  incompleteCandidates: number;
}

export interface AgentSessionDiagnostic {
  severity: AgentSessionDiagnosticSeverity;
  code: string;
  message: string;
}

export type AgentSessionReentryMode =
  | "focused-managed-pty"
  | "spawned-resume-pty"
  | "error";

export type AgentSessionReentryErrorCode =
  | "terminal-unavailable"
  | "cli-not-found"
  | "cwd-not-accessible"
  | "resume-unavailable"
  | "writer-active"
  | "external-active"
  | "unknown";

export interface AgentSessionReentryError {
  code: AgentSessionReentryErrorCode;
  message: string;
}

export interface AgentSessionReentryResult {
  mode: AgentSessionReentryMode;
  sessionId: string;
  ptyId?: string;
  command?: AgentResumeCommand;
  cwd?: string;
  error?: AgentSessionReentryError;
}

export function listAgentSessions(
  projectPath: string,
): Promise<AgentSessionsListResult> {
  return invoke<AgentSessionsListResult>("agent_sessions_list", {
    projectPath,
  });
}

/**
 * The sessions of a project no window works with, from the lists Desktop
 * holds and the ones saved in the project: no agent connection starts and
 * the project is not repaired or written.
 */
export function listSavedAgentSessions(
  projectPath: string,
): Promise<AgentSessionsListResult> {
  return invoke<AgentSessionsListResult>("agent_sessions_list_saved", {
    projectPath,
  });
}

export function refreshAgentSessions(
  projectPath: string,
): Promise<AgentSessionsListResult> {
  return invoke<AgentSessionsListResult>("agent_sessions_refresh", {
    projectPath,
  });
}

/**
 * A Sessions collection opened: the catalogue connections of agents that
 * list their sessions over ACP start and stay until the hold is released.
 */
export function holdAgentSessionCatalog(): Promise<number> {
  return invoke<number>("agent_sessions_hold_catalog");
}

export function releaseAgentSessionCatalog(hold: number): Promise<void> {
  return invoke<void>("agent_sessions_release_catalog", { hold });
}

/**
 * An explicit refresh or a return to the foreground: starts the catalogue
 * connections an open collection needs; without one it starts nothing.
 */
export function raiseAgentSessionCatalog(): Promise<void> {
  return invoke<void>("agent_sessions_raise_catalog");
}

export function hotStatusAgentSessions(
  projectPath: string,
  sessionIds: string[],
): Promise<AgentSessionsHotStatusResult> {
  return invoke<AgentSessionsHotStatusResult>("agent_sessions_hot_status", {
    projectPath,
    sessionIds,
  });
}

export function reenterAgentSession(
  projectPath: string,
  sessionId: string,
): Promise<AgentSessionReentryResult> {
  return invoke<AgentSessionReentryResult>("agent_sessions_reenter", {
    projectPath,
    sessionId,
  });
}
