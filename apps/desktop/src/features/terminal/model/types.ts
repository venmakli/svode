export type TerminalScope = "project" | "space";

export interface TerminalTarget {
  scope: TerminalScope;
  scopeId: string;
  name: string;
  path: string;
  secondaryPath: string;
}

export type TerminalTabStatus = "spawning" | "ready" | "error" | "exited";

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  scope: TerminalScope;
  scopeId: string;
  ptyId: string | null;
  status: TerminalTabStatus;
  error: string | null;
}
