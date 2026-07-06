import { invokeCommand as invoke } from "@/platform/native/invoke";

export type AgentSessionSource = "codex" | "claude-code";
export type AgentSessionStatus =
  | "active"
  | "done"
  | "failed"
  | "stopped"
  | "unknown";
export type AgentSessionActiveFlag =
  | "waitingOnApproval"
  | "waitingOnUserInput";
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
export type AgentSessionStatusSource =
  | "embedded-terminal"
  | "svode-agent-runtime"
  | "source-log"
  | "source-index"
  | "fallback";
export type AgentSessionStatusConfidence =
  | "strong"
  | "medium"
  | "weak"
  | "unknown";

export interface AgentSessionRuntime {
  ptyId?: string;
  pid?: number;
  live: boolean;
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
  source: AgentSessionSource;
  sourceSessionId: string;
  title: string;
  titleSource: AgentSessionTitleSource;
  status: AgentSessionStatus;
  activeFlags?: AgentSessionActiveFlag[];
  statusSource: AgentSessionStatusSource;
  statusConfidence: AgentSessionStatusConfidence;
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
  pinned: boolean;
  sourceMeta: AgentSessionSourceMeta;
}

export type AgentSessionsListStatus = "ok" | "partial" | "error";
export type AgentSessionsCacheMode =
  | "fresh-scan"
  | "fingerprint-hit"
  | "force-refresh"
  | "mixed";
export type AgentSessionSourceReportStatus =
  | "ok"
  | "missing-root"
  | "partial-error"
  | "unreadable"
  | "error";
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
  pinnedSessions: number;
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

export interface AgentSessionSourceReport {
  source: AgentSessionSource;
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
}

export interface AgentSessionDiagnostic {
  severity: AgentSessionDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface AgentSessionsPinResult {
  sessionId: string;
  pinned: boolean;
  pinnedSessionIds: string[];
  updatedAt: string;
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

export function setAgentSessionPinned(
  projectPath: string,
  sessionId: string,
  pinned: boolean,
): Promise<AgentSessionsPinResult> {
  return invoke<AgentSessionsPinResult>("agent_sessions_set_pinned", {
    projectPath,
    sessionId,
    pinned,
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
