export interface Project {
  id: string;
  name: string;
  icon: string;
  description: string;
  variant?: string | null;
  path?: string | null;
  workspaceCount: number;
  lastOpened: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  path: string;
  exists: boolean;
}

export interface ProjectConfig {
  type?: string;
  variant?: string;
  name: string;
  description: string;
  icon: string;
  workspaces: WorkspaceRef[];
  defaults: ProjectDefaults;
}

export interface WorkspaceRef {
  id: string;
  path: string;
}

export interface ProjectDefaults {
  agent?: unknown;
}

export interface WorkspaceConfig {
  name: string;
  description: string;
  icon: string;
  agent?: unknown;
}

export interface TreeNode {
  name: string;
  path: string;
  title: string;
  icon: string | null;
  has_changes: boolean;
  children: TreeNode[];
}

export interface AvailableAgent {
  name: string;
  path: string;
  version: string | null;
  authStatus: string;
  docsUrl: string;
}

export interface AppSettings {
  user: { name: string; avatar: string };
  appearance: { theme: string; language: string };
  window: { width: number; height: number };
}

export interface SymlinkHealthReport {
  ok: number;
  restored: number;
  errors: string[];
}
