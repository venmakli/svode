export interface GitAvailabilityDto {
  git: boolean;
  gitLfs: boolean;
  gitVersion: string | null;
  gitLfsVersion: string | null;
  gitVersionSupported: boolean;
  gitMinimumVersion: string;
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
      /** Svode service files this sync merged. */
      merged?: string[];
      parent?: ParentPublicationDto;
      remoteStatus?: GitStatusDto;
    }
  | {
      type: "conflict";
      files: string[];
      /** The kind of each unresolved path of `files`. */
      kinds?: GitPathConflictDto[];
      /** Svode service files this sync merged; the rest stay in `files`. */
      merged?: string[];
      service?: GitServiceFileDto[];
    }
  | { type: "resolved" }
  | { type: "noRemote" }
  | { type: "authRequired"; challenge?: GitAuthChallengeDto | null }
  | { type: "operationInProgress"; operation: GitOperationDto }
  | { type: "unmergedFiles"; files: string[]; kinds?: GitPathConflictDto[] }
  /**
   * The result chosen for a conflicted file has marker lines or does not
   * read: nothing was written, the path stays in conflict.
   */
  | { type: "unresolved"; path: string; finding: GitResolutionFindingDto }
  /**
   * The preflight of a background sync found a conflict beyond the Svode
   * service files: nothing was merged or published.
   */
  | {
      type: "incomingConflict";
      files: GitPathConflictDto[];
      service?: GitServiceFileDto[];
    }
  /** Diverged on a Git without merges in memory: only an explicit sync merges. */
  | { type: "explicitSyncRequired" }
  /**
   * An agent turn or a Routine run is in progress: the incoming changes
   * were fetched and are integrated after the turn; nothing was published.
   */
  | { type: "integrationAfterTurn" };

/** The kind of a conflicted path, as the person resolves it. */
export type GitConflictKindDto =
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
export interface GitPathConflictDto {
  path: string;
  kind: GitConflictKindDto;
}

/** What a version group is about (Stage 11 1.G). */
export type GitVersionGroupKindDto =
  | "operation"
  | "creation"
  | "page"
  | "fields"
  | "schema"
  | "attachments"
  | "folder"
  | "system"
  | "structural";

/** One uncommitted group: what one commit takes, as its message says it. */
export interface GitUncommittedGroupDto {
  kind: GitVersionGroupKindDto;
  /** The summary line of the message Svode would write. */
  header: string;
  /** Every fact of the group when the summary does not say them all. */
  facts: string[];
  /** Repository-relative paths the commit of the group takes. */
  paths: string[];
  /** Files of sensitive Collections, counted by folder instead of named. */
  hidden: { folder: string; files: number }[];
}

/** The uncommitted groups of an area in one repository. */
export interface GitUncommittedGroupsDto {
  /** The repository the paths of the groups are relative to. */
  repository: string;
  groups: GitUncommittedGroupDto[];
}

/** Why a chosen result does not resolve its path. */
export type GitResolutionFindingDto =
  | { type: "markers" }
  | { type: "unreadable"; message: string }
  | { type: "changed" };

/** A place of dispute of a text file: its marker lines and the sides. */
export interface GitConflictPlaceDto {
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
}

/** A conflicted path as "Changes" resolve it. */
export interface GitConflictFileDto {
  /** Relative to the requested path. */
  path: string;
  kind: GitConflictKindDto;
  version: string;
  content: string | null;
  places:
    | { type: "places"; places: GitConflictPlaceDto[] }
    | {
        type: "unclear";
        reason: "ambiguous" | "broken" | "no_markers" | "too_large";
      }
    | null;
  /** The versions of the sides before the merge that the index holds. */
  ours: boolean;
  theirs: boolean;
}

export type GitPlaceChoiceDto = "ours" | "theirs" | "both";

/** How the person resolves a text file in conflict. */
export type GitFileResolutionDto =
  | { type: "places"; version: string; choices: GitPlaceChoiceDto[] }
  | { type: "side"; side: "ours" | "theirs" };

/**
 * A conflicted Svode service file and what the rule set says about it: it
 * merges, or a Space pointer stays with its reason. Paths are relative to
 * the repository.
 */
export interface GitServiceFileDto {
  path: string;
  state: "mergeable" | "space_diverged" | "space_unavailable";
}

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
  autoCommitContent: boolean;
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
