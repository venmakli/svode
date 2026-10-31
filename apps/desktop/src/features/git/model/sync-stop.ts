import type { GitPublicationContentFinding } from "@/platform/git/publication-errors";
import type { GitOperation, GitServiceFile, SyncResult } from "./types";

/** What stops sync of a repository, or only its publication. */
export type GitSyncStop =
  /** A merge in progress; `service` are its conflicted Svode service files. */
  | { kind: "conflict"; files: string[]; service: GitServiceFile[] }
  | { kind: "operation"; operation: GitOperation }
  /** Files left in conflict with no operation, after a failed autostash. */
  | { kind: "unmerged"; files: string[] }
  /**
   * The publication guard kept outgoing commits local; fetch and integration
   * still run. `path` is relative to the repository.
   */
  | {
      kind: "publication";
      path: string;
      commit: string;
      finding: GitPublicationContentFinding;
    };

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
        service: result.service ?? [],
      };
    case "OperationInProgress":
      return { kind: "operation", operation: result.operation };
    case "UnmergedFiles":
      return { kind: "unmerged", files: result.files };
    case "Success":
    case "Resolved":
    case "AuthRequired":
      return null;
    case "NoRemote":
      // A background sync skipped by policy never reaches the preflight.
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
    case "Resolved":
      return [];
    case "AuthRequired":
    case "NoRemote":
      return undefined;
  }
}
