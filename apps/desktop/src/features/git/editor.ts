import {
  normalizeGitStatusPath,
  useGitStore,
  type GitSaveScope,
  type GitStatus,
} from "./model";
import { refreshGitStatus } from "./api/git-status-actions";
import {
  commitAllSpace as commitAllSpaceAction,
  commitFileAndMaybeSync as commitFileAndMaybeSyncAction,
  commitSaveScopeAndMaybeSync as commitSaveScopeAndMaybeSyncAction,
  continueGitResolve as continueGitResolveAction,
  syncSpace as syncSpaceAction,
  type GitCommitResult,
} from "./api/git-actions";
import {
  notifyGitResolveOutcome,
  notifyGitSyncOutcome,
} from "./effects/git-notifications";

export type { GitCommitResult } from "./api/git-actions";
export { registerPageSaveOwner } from "./model/page-save-owner";
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

/** Continues the merge with the saved Page `path`, named `page` in feedback. */
export function continueGitResolve(
  spacePath: string,
  path: string,
  page: string,
): Promise<void> {
  const normalized = normalizeGitStatusPath(path);
  const conflicted = getGitSpaceStatus(spacePath)?.files.some(
    (file) =>
      file.state === "conflict" &&
      normalizeGitStatusPath(file.path) === normalized,
  );
  return continueGitResolveAction(spacePath, [path], {
    onSyncOutcome: conflicted
      ? (outcome) => notifyGitResolveOutcome(outcome, page)
      : notifyGitSyncOutcome,
  });
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
