import type { GitPublicationBlock } from "./publication-block";
import type { GitSyncStop } from "./sync-stop";

export interface GitAvailability {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
  gitLfsVersion: string | null;
  /** False only for a recognised Git older than `gitMinimumVersion`. */
  gitVersionSupported: boolean;
  gitMinimumVersion: string;
}

export type FileGitState = "modified" | "untracked" | "deleted" | "conflict";

export interface FileGitStatus {
  path: string;
  state: FileGitState;
}

export interface GitStatus {
  repository?: string;
  branch: string;
  ahead: number;
  behind: number;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasConflicts: boolean;
  tracking: string | null;
  files: FileGitStatus[];
  totalFiles: number;
  omittedFiles: number;
}

/** Why the last status read of a Space failed. */
export type GitStatusFailure =
  | { kind: "timed_out"; repository: string }
  | { kind: "unavailable" };

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
  | {
      type: "Success";
      publishedHead?: string;
      /** Svode service files this sync merged. */
      merged?: string[];
      parent?: ParentPublication;
    }
  | {
      type: "Conflict";
      files: string[];
      /** Svode service files this sync merged; the rest stay in `files`. */
      merged?: string[];
      service?: GitServiceFile[];
    }
  | { type: "Resolved" }
  | { type: "NoRemote" }
  | { type: "AuthRequired"; challenge: GitAuthChallenge | null }
  | { type: "OperationInProgress"; operation: GitOperation }
  | { type: "UnmergedFiles"; files: string[] }
  /**
   * «Конфликт с правками коллег»: the preflight of a background sync found
   * a conflict beyond the Svode service files; nothing was merged or
   * published. `service` are the service files the rule set leaves.
   */
  | {
      type: "IncomingConflict";
      files: GitPathConflict[];
      service?: GitServiceFile[];
    }
  /** Diverged on a Git without merges in memory: only an explicit sync merges. */
  | { type: "ExplicitSyncRequired" }
  /**
   * An agent turn or a Routine run is in progress: the incoming changes
   * were fetched and are integrated after the turn; nothing was published.
   */
  | { type: "IntegrationAfterTurn" };

/** The kind of a conflicted path, as the person resolves it. */
export type GitConflictKind =
  | "page_text"
  | "page_properties"
  | "text"
  | "binary"
  | "modify_delete"
  | "add_add"
  | "rename_rename"
  | "rename_delete"
  | "space_pointer";

/** A conflicted path relative to the repository and its kind. */
export interface GitPathConflict {
  path: string;
  kind: GitConflictKind;
}

/**
 * A conflicted Svode service file: the rule set merges it, or a Space
 * pointer stays in conflict because the Space histories diverged or its
 * revision is unavailable. `path` is relative to the repository.
 */
export interface GitServiceFile {
  path: string;
  state: "mergeable" | "space_diverged" | "space_unavailable";
}

/** Unfinished Git operation other than a merge, which is a sync conflict. */
export type GitOperation = "rebase" | "cherry_pick" | "revert" | "sequencer";

export interface ParentPublication {
  repository: string;
  pointer: "pending" | "local" | "published" | "newer";
  target?: string;
  result?: SyncResult;
  error?: { kind: string; [key: string]: unknown };
  policySkipped?: boolean;
  /** Unrelated project commits that kept the pointer local after an explicit Space sync. */
  unpublishedCommits?: number;
}

export type GitSyncOutcome =
  | SyncResult
  | {
      type: "Failed";
      message: string;
      /** Spaces that stopped the project publication; a stop, not a failure. */
      block?: GitPublicationBlock;
      /** The publication guard kept the commits local; a stop, not a failure. */
      stop?: GitSyncStop;
    };

export interface GitUserPolicy {
  autoSync: boolean;
  autoCommitStructural: boolean;
  autoCommitSystem: boolean;
  autoCommitContent: boolean;
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

export interface GitPublicationStatus {
  childHead: string;
  child: "local" | "published" | "unpublished" | "unknown";
  inspectionError?: string;
  parent: ParentPublication;
}
