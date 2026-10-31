import type { GitPublicationContentFinding } from "@/platform/git/publication-errors";
import type { GitSaveFailureDto } from "@/platform/git/save-errors";
import type {
  GitOperation,
  GitOperationStep,
  GitPathConflict,
  GitServiceFile,
  SyncResult,
} from "./types";

/** What stops sync of a repository, or only its publication. */
export type GitSyncStop =
  /**
   * A merge in progress; `kinds` name the kind of each of `files`, `service`
   * are its conflicted Svode service files.
   */
  | {
      kind: "conflict";
      files: string[];
      kinds: GitPathConflict[];
      service: GitServiceFile[];
    }
  /**
   * A rebase, cherry-pick, revert or sequencer Svode does not continue:
   * `step` is where Git reports it stopped, `files` its paths in conflict.
   */
  | {
      kind: "operation";
      operation: GitOperation;
      step: GitOperationStep | null;
      files: string[];
      kinds: GitPathConflict[];
    }
  /** Files left in conflict with no operation, after a failed autostash. */
  | { kind: "unmerged"; files: string[]; kinds: GitPathConflict[] }
  /**
   * «Конфликт с правками коллег»: a background sync did not start a merge
   * that would stop with a conflict. Local work and versions go on; nothing
   * is published until an explicit sync merges and the paths are resolved.
   */
  | { kind: "incoming"; files: GitPathConflict[]; service: GitServiceFile[] }
  /**
   * Local and incoming commits diverged and this Git cannot check a merge
   * in memory: background sync only fast-forwards, an explicit sync merges.
   */
  | { kind: "explicit_sync" }
  /**
   * The publication guard kept outgoing commits local; fetch and integration
   * still run. `path` is relative to the repository.
   */
  | {
      kind: "publication";
      path: string;
      commit: string;
      finding: GitPublicationContentFinding;
    }
  /**
   * A background commit of automatic versions was refused; the edits stay
   * in the working copy until the next closing of a group tries again.
   */
  | {
      kind: "commit";
      cause: GitSaveFailureDto | null;
      branchMessage: string | null;
    };

/**
 * Stops that do not keep sync from running: publication and automatic
 * commits resume through it or alongside it, and an explicit sync is how
 * the incoming changes of a background stop are merged.
 */
export function syncStopBlocksSync(stop: GitSyncStop): boolean {
  return (
    stop.kind !== "publication" &&
    stop.kind !== "commit" &&
    stop.kind !== "incoming" &&
    stop.kind !== "explicit_sync"
  );
}

/**
 * Stops a background sync reports from its in-memory preflight: they are
 * not states of the repository, so a read of the repository does not end
 * them; the next sync does.
 */
export function syncStopIsBackgroundPreflight(stop: GitSyncStop): boolean {
  return stop.kind === "incoming" || stop.kind === "explicit_sync";
}

/**
 * The stop a sync result reports: `null` when sync got past its preflight,
 * `undefined` when the result says nothing about it.
 */
export function syncStopFromResult(
  result: SyncResult,
): GitSyncStop | null | undefined {
  switch (result.type) {
    case "Conflict":
      return {
        kind: "conflict",
        files: result.files,
        kinds: result.kinds,
        service: result.service ?? [],
      };
    case "OperationInProgress":
      return {
        kind: "operation",
        operation: result.operation,
        step: result.step,
        files: result.files,
        kinds: result.kinds,
      };
    case "UnmergedFiles":
      return { kind: "unmerged", files: result.files, kinds: result.kinds };
    case "IncomingConflict":
      return {
        kind: "incoming",
        files: result.files,
        service: result.service ?? [],
      };
    case "ExplicitSyncRequired":
      return { kind: "explicit_sync" };
    case "Success":
    case "Resolved":
    case "AuthRequired":
      return null;
    case "NoRemote":
      // A background sync skipped by policy never reaches the preflight.
      return undefined;
    // Not a stop: the integration runs after the agent's turn, and a refused
    // choice leaves the merge stop as it was.
    case "IntegrationAfterTurn":
    case "Unresolved":
      return undefined;
  }
}

/**
 * The Svode service files a sync merged: named by its result, `undefined`
 * when the result says nothing about them.
 */
export function serviceMergedFromResult(
  result: SyncResult,
): string[] | undefined {
  switch (result.type) {
    case "Success":
    case "Conflict":
      return result.merged ?? [];
    case "OperationInProgress":
    case "UnmergedFiles":
    case "IncomingConflict":
    case "ExplicitSyncRequired":
    case "Resolved":
      return [];
    case "AuthRequired":
    case "NoRemote":
    case "IntegrationAfterTurn":
    case "Unresolved":
      return undefined;
  }
}
