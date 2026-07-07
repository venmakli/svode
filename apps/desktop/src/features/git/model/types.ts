export interface GitAvailability {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
  gitLfsVersion: string | null;
}

export type FileGitState = "modified" | "untracked" | "deleted" | "conflict";

export interface FileGitStatus {
  path: string;
  state: FileGitState;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasConflicts: boolean;
  tracking: string | null;
  files: FileGitStatus[];
}

export type GitRemoteOperation =
  | "sync"
  | "clone"
  | "first-push"
  | "fetch"
  | "lfs-diagnostics"
  | "lfs-fetch-pull"
  | "unknown";

export type GitRemoteAuthMethod = "https" | "ssh" | "unknown";

export interface GitAuthChallenge {
  operation: GitRemoteOperation;
  authMethod: GitRemoteAuthMethod;
  remoteUrl: string | null;
  host: string | null;
  repository: string | null;
  providerHint: string | null;
  detail: string | null;
}

export interface GitRemoteAuthCredentials {
  username: string;
  password: string;
}

export type SyncResult =
  | { type: "Success" }
  | { type: "Conflict"; files: string[] }
  | { type: "NoRemote" }
  | { type: "AuthRequired"; challenge: GitAuthChallenge | null };

export type GitSyncOutcome = SyncResult | { type: "Failed"; message: string };

export interface GitUserPolicy {
  autoSync: boolean;
  autoCommitStructural: boolean;
  autoCommitSystem: boolean;
}

export interface CloneProgress {
  spacePath: string;
  phase: string;
  percent: number;
}

export type GitCloneProgressStatus = "starting" | "progress" | "failed";

export interface GitCloneProgress {
  status: GitCloneProgressStatus;
  phase: string | null;
  percent: number;
  error?: string;
}

export interface GitUnpushedCommit {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}
