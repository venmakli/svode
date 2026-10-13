import type { GitOperation, SyncResult } from "./types";

/** An unfinished Git operation that stops sync of a repository. */
export type GitSyncStop =
  | { kind: "conflict"; files: string[] }
  | { kind: "operation"; operation: GitOperation };

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
    case "Success":
    case "Resolved":
    case "AuthRequired":
      return null;
    case "NoRemote":
      // A background sync skipped by policy never reaches the preflight.
      return undefined;
  }
}
