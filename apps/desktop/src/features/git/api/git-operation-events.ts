import { listenGitSyncState } from "@/platform/git/git-api";
import { useGitStore } from "../model";
import { gitBranchErrorMessage } from "./git-branch-error";
import { gitSyncErrorMessage } from "./git-sync-error";
import { toGitStatus, toSyncResult } from "./git-mappers";
import { recordSyncPublication } from "./git-publication-actions";

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
    git.setBranchError(path, null);
    return;
  }
  if (event.error) {
    const branch = gitBranchErrorMessage(event.error);
    git.setBranchError(path, branch);
    git.setSyncError(path, branch ? null : gitSyncErrorMessage(event.error));
    return;
  }
  if (!event.report) return;
  const outcome = toSyncResult(event.report);
  recordSyncPublication(path, outcome);
  if (event.report.type === "success" && event.report.remoteStatus) {
    git.applyRemoteStatus(path, toGitStatus(event.report.remoteStatus));
  }
  if (outcome.type === "AuthRequired") git.setSyncError(path, "auth");
  if (outcome.type === "Conflict") git.setSyncError(path, "conflict");
}
