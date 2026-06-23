import { useGitStore, type GitStatus } from "./model";
import { refreshGitStatus } from "./api/git-status-actions";
import {
  commitAllSpace as commitAllSpaceAction,
  commitFileAndMaybeSync as commitFileAndMaybeSyncAction,
  continueGitResolve as continueGitResolveAction,
  syncSpace as syncSpaceAction,
  type GitAutoSyncOptions,
  type GitCommitResult,
} from "./api/git-actions";
import { notifyGitSyncOutcome } from "./effects/git-notifications";

export type { GitCommitResult } from "./api/git-actions";

const notifyAutoSync: GitAutoSyncOptions = {
  onSyncOutcome: notifyGitSyncOutcome,
};

export function commitFileAndMaybeSync(
  spacePath: string,
  filePath: string,
  projectPath?: string,
): Promise<GitCommitResult | null> {
  return commitFileAndMaybeSyncAction(
    spacePath,
    filePath,
    projectPath,
    notifyAutoSync,
  );
}

export function commitAllSpace(
  spacePath: string,
  projectPath?: string,
): Promise<GitCommitResult | null> {
  return commitAllSpaceAction(spacePath, projectPath, notifyAutoSync);
}

export function continueGitResolve(spacePath: string): Promise<void> {
  return continueGitResolveAction(spacePath, notifyAutoSync);
}

export async function syncSpace(spacePath: string): Promise<void> {
  notifyGitSyncOutcome(await syncSpaceAction(spacePath));
}

export function getGitSpaceStatus(spacePath: string): GitStatus | undefined {
  return useGitStore.getState().statuses[spacePath];
}

export function refreshGitSpaceStatus(spacePath: string): Promise<void> {
  return refreshGitStatus(spacePath);
}
