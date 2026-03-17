export interface Project {
  id: string;
  name: string;
  icon: string;
  description: string;
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

/**
 * Tree node from the Rust files engine.
 * Rust enum serialized with #[serde(tag = "type")]:
 * - { type: "Page", name, path, has_changes }
 * - { type: "Category", name, path, children }
 */
export type TreeNode =
  | { type: "Page"; name: string; path: string; has_changes: boolean }
  | { type: "Category"; name: string; path: string; children: TreeNode[] };
