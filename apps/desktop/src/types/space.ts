export type {
  AgentConfig,
  AssetsS3Config,
  AssetsSpaceConfig,
  AssetsStrategy,
  GitSpaceConfig,
  LfsState,
  LocalConfig,
  SpaceConfig,
  SpaceDefaults,
  SpaceGitType,
  SpaceInfo,
  SpaceRef,
  SpaceStatus,
} from "@/features/space";
export type { TreeNode } from "@/features/entry";

export interface AvailableAgent {
  name: string;
  path: string;
  version: string | null;
  authStatus: string;
  docsUrl: string;
}

export interface AppSettings {
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
