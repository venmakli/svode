export type TerminalScope = "project" | "space";

export interface TerminalTarget {
  scope: TerminalScope;
  scopeId: string;
  name: string;
  path: string;
  secondaryPath: string;
}

export type TerminalTabStatus = "spawning" | "ready" | "error" | "exited";
export type TerminalTabOrigin = "shell" | "agent-session";
export type TerminalAgentSessionSource = "codex" | "claude-code";

export interface TerminalAgentSurface {
  ptyId: string;
  agentSessionId: string;
  title?: string | null;
  source: TerminalAgentSessionSource;
  sourceSessionId: string;
  shellCwd: string;
  createdAt: string;
  lastOutputAt?: string | null;
  lastInputAt?: string | null;
}

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  scope: TerminalScope;
  scopeId: string;
  ptyId: string | null;
  status: TerminalTabStatus;
  error: string | null;
  origin: TerminalTabOrigin;
  createdAt: string;
  agentSessionId?: string;
  agentSessionSource?: TerminalAgentSessionSource;
  agentSourceSessionId?: string;
}
