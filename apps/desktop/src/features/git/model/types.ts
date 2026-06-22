export interface GitAvailability {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
}

export type FileGitState = "modified" | "untracked" | "conflict";

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

export type SyncResult =
  | { type: "Success" }
  | { type: "Conflict"; files: string[] }
  | { type: "NoRemote" }
  | { type: "AuthRequired" };

export interface CloneProgress {
  spacePath: string;
  phase: string;
  percent: number;
}

export interface GitCloneProgress {
  phase: string;
  percent: number;
  error?: string;
}

export interface GitUnpushedCommit {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}
