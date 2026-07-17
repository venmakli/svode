export type SpaceGitType = "inline" | "independent" | "submodule";

export type SpaceStatus = "ready" | "missing" | "broken";

export type LfsState = "n/a" | "ready" | "missing-creds" | "pulling";

export type WindowOpenIntent =
  | { kind: "home" }
  | { kind: "project"; projectId: string };

export interface SpaceInfo {
  id: string;
  name: string;
  icon: string;
  description: string;
  path: string;
  hasSpaces: boolean;
  hasSchema: boolean;
  lastOpened: string | null;
  status: SpaceStatus;
  lfsState: LfsState;
}

export interface TreeNode {
  name: string;
  path: string;
  title: string;
  icon: string | null;
  description?: string | null;
  has_changes: boolean;
  has_schema: boolean;
  parent?: string | null;
  kind?: "document" | "folder" | "collection";
  hasChildren?: boolean;
  has_children?: boolean;
  children: TreeNode[];
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
  autoSync?: boolean;
  autoCommitStructural?: boolean;
  autoCommitSystem?: boolean;
}

export type AssetsStrategy = "local" | "in-git" | "lfs-remote" | "lfs-s3";

export interface AssetsS3Config {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
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

export interface LocalConfig {
  agent?: unknown;
  expandedPaths: string[];
}
