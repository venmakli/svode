import {
  gitStatusPathInConflict,
  useGitStore,
  type GitSaveScope,
  type GitStatus,
} from "./model";
import { refreshGitStatus } from "./api/git-status-actions";
import {
  commitAllSpace as commitAllSpaceAction,
  commitFileAndMaybeSync as commitFileAndMaybeSyncAction,
  commitPathsAndMaybeSync as commitPathsAndMaybeSyncAction,
  commitSaveScopeAndMaybeSync as commitSaveScopeAndMaybeSyncAction,
  continueGitResolve as continueGitResolveAction,
  syncSpace as syncSpaceAction,
  type GitCommitResult,
} from "./api/git-actions";
import {
  notifyGitResolveFailed,
  notifyGitResolveOutcome,
  notifyGitSyncFailed,
  notifyGitSyncOutcome,
} from "./effects/git-notifications";

export type { GitCommitResult } from "./api/git-actions";
export {
  explicitCommitRefusal,
  registerPageSaveOwner,
  type GitCommitRefusal,
} from "./model/page-save-owner";
export {
  notifyGitCommitRefusal,
  notifyGitSaveFailure,
} from "./effects/git-notifications";
export {
  dirtyPathsForGitSaveScope,
  gitSaveShortcutLabel,
  gitStatusHasDirtyPath,
  resolveGitSaveAllScope,
  selfPathsForGitSaveScope,
  type GitSaveScope,
  type GitSaveScopeLabel,
  type GitSaveScopeTreeNode,
} from "./model";

export function commitFileAndMaybeSync(
  spacePath: string,
  filePath: string,
  projectPath?: string,
): Promise<GitCommitResult | null> {
  return commitFileAndMaybeSyncAction(spacePath, filePath, projectPath);
}

export function commitAllSpace(
  spacePath: string,
  projectPath?: string,
): Promise<GitCommitResult | null> {
  return commitAllSpaceAction(spacePath, projectPath);
}

/** Commit exactly `filePaths` of a Space, one commit per version group. */
export function commitPathsAndMaybeSync(
  spacePath: string,
  filePaths: string[],
  projectPath?: string,
): Promise<GitCommitResult | null> {
  return commitPathsAndMaybeSyncAction(spacePath, filePaths, projectPath);
}

export function commitSaveScopeAndMaybeSync(
  spacePath: string,
  scope: GitSaveScope,
  extraPaths: string[],
  projectPath?: string,
): Promise<GitCommitResult | null> {
  return commitSaveScopeAndMaybeSyncAction(
    spacePath,
    scope,
    extraPaths,
    projectPath,
  );
}

/** Git holds the Page `path` of the Space unresolved, in a merge or without an operation. */
export function gitPathInConflict(spacePath: string, path: string): boolean {
  return gitStatusPathInConflict(getGitSpaceStatus(spacePath), path);
}

/**
 * Continues the merge with the saved Page `path`, named `page` in feedback;
 * a refusal to resolve it is named, never thrown (DF-294 R5).
 */
export async function continueGitResolve(
  spacePath: string,
  path: string,
  page: string,
): Promise<void> {
  const conflicted = gitPathInConflict(spacePath, path);
  try {
    await continueGitResolveAction(spacePath, [path], {
      onSyncOutcome: conflicted
        ? (outcome) => notifyGitResolveOutcome(outcome, page)
        : notifyGitSyncOutcome,
    });
  } catch (error) {
    console.error("git merge resolution failed:", error);
    if (conflicted) notifyGitResolveFailed(page);
    else notifyGitSyncFailed();
  }
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
