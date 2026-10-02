import type { AgentSessionStatusDto } from "@/platform/agent-runtime/agent-runtime-api";
import { invokeCommand as invoke } from "@/platform/native/invoke";

/** The id of the session's agent in the registry. */
export type AgentSessionSource = string;
/** The one session status vocabulary of the agent runtime (Stage 10 C10). */
export type AgentSessionStatus = AgentSessionStatusDto;
export type AgentSessionTitleSource =
  | "cli-title"
  | "first-user-prompt"
  | "session-id";
export type AgentSessionScopeKind = "project" | "space";
export type AgentSessionScopeStatus = "ready" | "missing" | "broken";
export type AgentSessionScopeConfidence =
  | "exact"
  | "cwd-prefix"
  | "worktree-original"
  | "decoded-source-file";

export interface AgentSessionRuntime {
  ptyId?: string;
  pid?: number;
  live: boolean;
  provisional?: boolean;
  lastOutputAt?: string;
  lastInputAt?: string;
}

export interface AgentResumeCommand {
  display: string;
  program: string;
  args: string[];
  cwd?: string;
}

export interface AgentSessionFileRef {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface AgentSessionCounts {
  messages?: number;
  userMessages: number;
  assistantMessages: number;
  functionCalls: number;
  malformedLines: number;
}

export interface AgentSessionCapabilities {
  canResume: boolean;
  canRevealFile: boolean;
  hasReadableLog: boolean;
}

export interface AgentSessionSourceMeta {
  historyPresent: boolean;
  detailPresent: boolean;
  sessionIndexPresent: boolean;
  detailFileCount: number;
  historyLineCount: number;
  detailLineCount: number;
  malformedLineCount: number;
  functionCallCount: number;
  notes: string[];
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
  durationMs?: number;
  resumeCommand?: AgentResumeCommand;
  sourceFile?: AgentSessionFileRef;
  counts?: AgentSessionCounts;
  capabilities: AgentSessionCapabilities;
  sourceMeta: AgentSessionSourceMeta;
}

export type AgentSessionsListStatus = "ok" | "partial" | "error";
export type AgentSessionsCacheMode =
  | "fresh-scan"
  | "fingerprint-hit"
  | "force-refresh"
  | "mixed"
  | "stale-snapshot";
export type AgentSessionSourceReportStatus =
  | "ok"
  | "missing-root"
  | "partial-error"
  | "unreadable"
  | "error"
  /** The last good list is shown; the agent did not answer or is not connected. */
  | "stale";
/** A source reads the agent's native store or its ACP `session/list`. */
export type AgentSessionSourceKind = "native-log" | "acp-list";
export type AgentSessionDiagnosticSeverity = "info" | "warning" | "error";

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
  malformedLines: number;
  sourceErrors: number;
}

export interface AgentSessionsCacheState {
  mode: AgentSessionsCacheMode;
  hit: boolean;
  sourceHits: number;
  sourceMisses: number;
}

export interface AgentSessionsHotStatusResult {
  generatedAt: string;
  projectPath: string;
  sessions: AgentSession[];
  checkedSessions: number;
  updatedSessions: number;
  skippedSessions: number;
  sources: AgentSessionSourceReport[];
}

export interface AgentSessionSourceReport {
  source: AgentSessionSource;
  kind: AgentSessionSourceKind;
  status: AgentSessionSourceReportStatus;
  rootPath: string;
  scannedAt: string;
  cacheHit: boolean;
  durationMs?: number;
  counts: AgentSessionSourceCounts;
  fingerprint?: string;
  diagnostics: AgentSessionDiagnostic[];
  truncatedDiagnostics: number;
}

export interface AgentSessionSourceCounts {
  filesScanned: number;
  recordsRead: number;
  candidates: number;
  returnedSessions: number;
  unresolvedCandidates: number;
  incompleteCandidates: number;
  malformedLines: number;
  sourceErrors: number;
  hotFilesChecked: number;
  hotFilesReparsed: number;
}

export interface AgentSessionDiagnostic {
  severity: AgentSessionDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  line?: number;
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
