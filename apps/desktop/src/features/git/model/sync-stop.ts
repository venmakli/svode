import type { GitPublicationContentFinding } from "@/platform/git/publication-errors";
import type { GitOperation, SyncResult } from "./types";

/** What stops sync of a repository, or only its publication. */
export type GitSyncStop =
  | { kind: "conflict"; files: string[] }
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
      return { kind: "conflict", files: result.files };
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
