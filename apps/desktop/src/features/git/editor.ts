import {
  conflictFileOpener,
  conflictResolvedByEditorWrite,
  gitStatusPathInConflict,
  useGitStore,
  type GitSaveScope,
  type GitStatus,
} from "./model";
import { readGitPathConflictKind } from "./api/git-conflict-actions";
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
  notifyGitPageAwaitsChanges,
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
 * a refusal to resolve it is named, never thrown (DF-294 R5). A conflict a
 * write does not decide, such as modify/delete, stays unresolved and is not
 * sent; an `explicitSave` names where its choice is made (DF-354 R1, R4).
 */
export async function continueGitResolve(
  spacePath: string,
  path: string,
  page: string,
  { explicitSave = false }: { explicitSave?: boolean } = {},
): Promise<void> {
  const conflicted = gitPathInConflict(spacePath, path);
  if (conflicted && !(await resolvedByEditorWrite(spacePath, path))) {
    if (explicitSave)
      notifyGitPageAwaitsChanges(page, conflictFileOpener({ spacePath, path }));
    return;
  }
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

/**
 * Whether a write decides the conflict of `path` by its kind; a kind that
 * does not read leaves the path to an explicit choice.
 */
async function resolvedByEditorWrite(
  spacePath: string,
  path: string,
): Promise<boolean> {
  try {
    const kind = await readGitPathConflictKind(spacePath, path);
    return kind === null || conflictResolvedByEditorWrite(kind);
  } catch (error) {
    console.error("git conflict kind unavailable:", error);
    return false;
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
