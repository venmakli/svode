export interface GitAvailabilityDto {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
  gitLfsVersion: string | null;
}

export type FileGitStateDto = "modified" | "untracked" | "deleted" | "conflict";

export interface FileGitStatusDto {
  path: string;
  state: FileGitStateDto;
}

export interface GitStatusDto {
  repository?: string;
  parent?: ParentPublicationDto;
  branch: string;
  ahead: number;
  behind: number;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasConflicts: boolean;
  tracking: string | null;
  /** At most 20 000 paths, conflicts first. */
  files: FileGitStatusDto[];
  /** Changed paths of the repository, listed in `files` or not. */
  totalFiles: number;
  /** Changed paths left out of `files` by the list limit. */
  omittedFiles: number;
}

export interface UnpushedCommitDto {
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}

export type GitRemoteOperationDto =
  | "sync"
  | "clone"
  | "first-push"
  | "fetch"
  | "lfs-diagnostics"
  | "lfs-fetch-pull"
  | "unknown";

export type GitRemoteAuthMethodDto = "https" | "ssh" | "unknown";

export interface GitAuthChallengeDto {
  operation: GitRemoteOperationDto;
  authMethod: GitRemoteAuthMethodDto;
  remoteUrl: string | null;
  host: string | null;
  repository: string | null;
  providerHint: string | null;
  detail: string | null;
}

export type SyncResultDto =
  | {
      type: "success";
      publishedHead?: string;
      parent?: ParentPublicationDto;
      remoteStatus?: GitStatusDto;
    }
  | { type: "conflict"; files: string[] }
  | { type: "resolved" }
  | { type: "noRemote" }
  | { type: "authRequired"; challenge?: GitAuthChallengeDto | null }
  | { type: "operationInProgress"; operation: GitOperationDto }
  | { type: "unmergedFiles"; files: string[] };

/** A merge in progress arrives as `conflict` with its files. */
export type GitOperationDto = "rebase" | "cherry_pick" | "revert" | "sequencer";

export interface ParentPublicationDto {
  repository: string;
  pointer: "pending" | "local" | "published" | "newer";
  target?: string;
  result?: SyncResultDto;
  error?: string | { kind: string; [key: string]: unknown };
  policySkipped?: boolean;
  unpublishedCommits?: number;
}

/** One Space a project publication took, by its gitlink path in the project. */
export interface SpaceStepDto {
  path: string;
  status: "published" | "failed" | "not_run";
  /** The Space sync with its pointer step, when the sync ran. */
  report?: SyncResultDto;
  error?: string | { kind: string; [key: string]: unknown };
}

export interface SpacesPublicationDto {
  spaces: SpaceStepDto[];
  /** The project sync, run once when every blocker was published. */
  project?: SyncResultDto;
  projectError?: string | { kind: string; [key: string]: unknown };
}

export interface GitUserPolicyDto {
  autoSync: boolean;
  autoCommitStructural: boolean;
  autoCommitSystem: boolean;
}

export interface CloneProgressDto {
  spacePath: string;
  phase: string;
  percent: number;
}

export interface PublicationStatusDto {
  childHead: string;
  child: "local" | "published" | "unpublished" | "unknown";
  inspectionError?: string | { kind: string; [key: string]: unknown };
  parent: ParentPublicationDto;
}
