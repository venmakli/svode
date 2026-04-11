// --- Unified workspace model ---

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  description: string;
  path: string;
  hasChildren: boolean;
  lastOpened: string | null;
}

export interface WorkspaceConfig {
  name: string;
  description: string;
  icon: string;
  children?: ChildRef[];
  agent?: AgentConfig;
  defaults?: WorkspaceDefaults;
  git?: GitWorkspaceConfig;
  assets?: AssetsWorkspaceConfig;
}

export interface GitWorkspaceConfig {
  /** Auto pull+push after each commit. Default: true. */
  autoSync?: boolean;
}

export type AssetsStrategy = "local" | "in-git" | "lfs-remote" | "lfs-s3";

export interface AssetsS3Config {
  endpoint: string;
  bucket: string;
  region: string;
}

export interface AssetsWorkspaceConfig {
  strategy: AssetsStrategy;
  s3?: AssetsS3Config;
}

export interface ChildRef {
  id: string;
  path: string;
  repo?: string;
}

export interface AgentConfig {
  clis?: string[];
  defaultModel?: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxTimeout?: number;
}

export interface WorkspaceDefaults {
  agent?: AgentConfig;
}

// --- Shared types ---

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
  agents?: AppAgentSettings;
}

export interface AppAgentSettings {
  detected: DetectedCli[];
  lastScan?: string;
}

export interface DetectedCli {
  name: string;
  path: string;
  version?: string;
  authStatus: string;
}

export interface SymlinkHealthReport {
  ok: number;
  restored: number;
  errors: string[];
}

export interface LocalConfig {
  agent?: unknown;
  expandedPaths: string[];
}
