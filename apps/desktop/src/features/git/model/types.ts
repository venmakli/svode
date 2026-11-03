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
      /** Items this sync gave a new `unique_id` number. */
      renumbered?: GitRenumberedItem[];
      parent?: ParentPublication;
    }
  | {
      type: "Conflict";
      files: string[];
      /** The kind of each unresolved path of `files`. */
      kinds: GitPathConflict[];
      /** Svode service files this sync merged; the rest stay in `files`. */
      merged?: string[];
      service?: GitServiceFile[];
      /** Items this sync gave a new `unique_id` number before the stop. */
      renumbered?: GitRenumberedItem[];
    }
  | { type: "Resolved" }
  | { type: "NoRemote" }
  | { type: "AuthRequired"; challenge: GitAuthChallenge | null }
  /**
   * A rebase, cherry-pick, revert or sequencer stopped: its step when Git
   * reports one, the commits the abort of a cherry-pick or revert sequence
   * drops, and its paths in conflict with their kinds.
   */
  | {
      type: "OperationInProgress";
      operation: GitOperation;
      step: GitOperationStep | null;
      sequence?: GitSequenceCommits;
      files: string[];
      kinds: GitPathConflict[];
    }
  | { type: "UnmergedFiles"; files: string[]; kinds: GitPathConflict[] }
  /**
   * The result chosen for a conflicted file has marker lines or does not
   * read: nothing was written, the path stays in conflict.
   */
  | { type: "Unresolved"; path: string; finding: GitResolutionFinding }
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

/** Why a chosen result does not resolve its path. */
export type GitResolutionFinding =
  | { type: "markers" }
  | { type: "unreadable"; message: string }
  | { type: "changed" }
  /** The incoming version of an LFS file has no object; the message says why. */
  | { type: "lfs_object"; message: string };

/** A place of dispute of a text file: its marker lines and the sides. */
export interface GitConflictPlace {
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
  /**
   * The place lies in the frontmatter of a Page, through its closing `---`
   * included: both sides there would repeat its keys, so «Принять оба» is
   * not offered.
   */
  frontmatter: boolean;
}

/** Why the places of a text file in conflict are not told apart. */
export type GitConflictUnclearReason =
  | "ambiguous"
  | "broken"
  | "no_markers"
  | "too_large";

/** A conflicted path as "Changes" resolve it. */
export interface GitConflictFile {
  /** Relative to the Space it was read for. */
  path: string;
  kind: GitConflictKind;
  /** The version of the working file its places come from. */
  version: string;
  content: string | null;
  /** For a text file: its places or why there are none. */
  places:
    | { type: "places"; places: GitConflictPlace[] }
    | { type: "unclear"; reason: GitConflictUnclearReason }
    | null;
  /** The versions of the sides before the merge that the index holds. */
  ours: boolean;
  theirs: boolean;
  /** Git does not merge the sides as text: a binary or LFS file. */
  binary: boolean;
  /** For a file without markers: what each side did with it. */
  changes: { ours: GitSideChange; theirs: GitSideChange } | null;
}

/** What one side of a merge did with a file without markers. */
export interface GitSideChange {
  change: "modified" | "added" | "deleted" | "renamed";
  /** The name the side renamed the file to, relative to the Space. */
  path: string | null;
  /** Bytes of the version of the side, for a binary file. */
  size: number | null;
}

export type GitPlaceChoice = "ours" | "theirs" | "both";

/** How the person resolves a file in conflict. */
export type GitFileResolution =
  | { type: "places"; version: string; choices: GitPlaceChoice[] }
  /** The version of a side; for rename/rename the file under its name. */
  | { type: "side"; side: "ours" | "theirs" }
  /** Remove the path, as the side that deleted the file did. */
  | { type: "delete" }
  /** Mine stays, the incoming version goes beside it as a copy. */
  | { type: "keepBoth" };

/** A conflicted path relative to the repository and its kind. */
export interface GitPathConflict {
  path: string;
  kind: GitConflictKind;
  /**
   * The title of the Page at the path from its versions, whatever the
   * sidebar loaded; absent for a path that is not a Page or does not read.
   */
  name?: string;
  /**
   * The other paths of the same conflict, resolved with it: the original
   * and the incoming name of a rename/rename conflict at my name.
   */
  also?: string[];
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

/**
 * An item that repeated a `unique_id` number published upstream and got a
 * new one after the sync integrated it (DF-237 R5): `from` and `to` carry
 * the prefix of the column, `collection` is the title of its Collection and
 * `path` is relative to the repository.
 */
export interface GitRenumberedItem {
  path: string;
  title: string;
  collection: string;
  from: string;
  to: string;
}

/**
 * What the last sync of a repository did on its own: the Svode service files
 * it merged and the items it renumbered.
 */
export interface GitSyncMerged {
  files: string[];
  renumbered: GitRenumberedItem[];
}

/** Unfinished Git operation other than a merge, which is a sync conflict. */
export type GitOperation = "rebase" | "cherry_pick" | "revert" | "sequencer";

/**
 * Where a stopped operation is, as Git reports it: a rebase at commit
 * `current` of `total`, a cherry-pick or revert sequence with `count`
 * commits left, the stopped one included.
 */
export type GitOperationStep =
  | { kind: "position"; current: number; total: number }
  | { kind: "remaining"; count: number };

/**
 * What the abort of a stopped cherry-pick or revert sequence drops: `count`
 * commits from its start to `head`, the titles of the newest few, newest
 * first; `count` beyond `titles.length` is only counted.
 */
export interface GitSequenceCommits {
  head: string;
  count: number;
  titles: string[];
}

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
