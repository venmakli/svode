// --- Unified space model ---

export type SpaceGitType = "inline" | "independent" | "submodule";

export type SpaceStatus = "ready" | "missing" | "broken";

export interface SpaceInfo {
  id: string;
  name: string;
  icon: string;
  description: string;
  path: string;
  hasSpaces: boolean;
  lastOpened: string | null;
  status: SpaceStatus;
}

export interface SpaceConfig {
  name: string;
  description: string;
  icon: string;
  spaces?: SpaceRef[];
  agent?: AgentConfig;
  defaults?: SpaceDefaults;
  git?: GitSpaceConfig;
  assets?: AssetsSpaceConfig;
}

export interface GitSpaceConfig {
  /** Auto pull+push after each commit. Default: true. */
  autoSync?: boolean;
}

export type AssetsStrategy = "local" | "in-git" | "lfs-remote" | "lfs-s3";

export interface AssetsS3Config {
  endpoint: string;
  bucket: string;
  region: string;
}

export interface AssetsSpaceConfig {
  strategy: AssetsStrategy;
  s3?: AssetsS3Config;
}

export interface SpaceRef {
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

export interface SpaceDefaults {
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
