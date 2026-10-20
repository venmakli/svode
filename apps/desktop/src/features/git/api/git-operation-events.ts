import { listenGitSyncState } from "@/platform/git/git-api";
import type { SyncResultDto } from "@/platform/git/git-types";
import { useGitStore } from "../model";
import { gitBranchErrorMessage } from "./git-branch-error";
import { gitSyncErrorMessage, toGitPublicationBlock } from "./git-sync-error";
import { toGitStatus, toSyncResult } from "./git-mappers";
import { recordSyncPublication } from "./git-publication-actions";
import { recordSyncStop } from "./git-sync-stop-actions";

export function listenGitOperationOutcomes() {
  return listenGitSyncState(recordGitOperationOutcome);
}

export function recordGitOperationOutcome(
  event: Parameters<Parameters<typeof listenGitSyncState>[0]>[0],
) {
  const git = useGitStore.getState();
  const path = event.repository;
  git.updateBackendSyncing(path, event.active);
  if (event.active) {
    git.setSyncError(path, null);
    git.setPublicationBlock(path, null);
    git.setBranchError(path, null);
    return;
  }
  recordGitSyncResult(path, event.report, event.error);
}

/** Record a finished sync of `path` from its report or error. */
export function recordGitSyncResult(
  path: string,
  report: SyncResultDto | null | undefined,
  error: unknown,
) {
  const git = useGitStore.getState();
  if (error) {
    const branch = gitBranchErrorMessage(error);
    const block = toGitPublicationBlock(error);
    git.setBranchError(path, branch);
    git.setPublicationBlock(path, block);
    git.setSyncError(path, branch || block ? null : gitSyncErrorMessage(error));
    return;
  }
  if (!report) return;
  const outcome = toSyncResult(report);
  recordSyncPublication(path, outcome);
  recordSyncStop(path, outcome);
  if (report.type === "success" && report.remoteStatus) {
    git.applyRemoteStatus(path, toGitStatus(report.remoteStatus));
  }
  if (outcome.type === "AuthRequired") git.setSyncError(path, "auth");
}
