import {
  recordSavedPublication,
  recordSyncPublication,
} from "./git-publication-actions";
import { gitBranchErrorMessage } from "./git-branch-error";
import {
  gitSyncErrorMessage,
  toGitPublicationBlock,
  toGitPublicationStop,
} from "./git-sync-error";
import { useGitStore } from "../model";
import {
  commitGitAll,
  commitGitFile,
  commitGitPaths,
  continueGitResolve as continuePlatformGitResolve,
  mergeGitServiceFiles as mergePlatformGitServiceFiles,
  saveGitHttpCredentials,
  syncGit,
  triggerGitSync,
} from "@/platform/git/git-api";
import {
  dirtyPathsForGitSaveScope,
  normalizeGitStatusPath,
  type GitSaveScope,
  type GitStatus,
  type GitSyncOutcome,
} from "../model";
import { toGitStatus, toSyncResult } from "./git-mappers";
import { recordPublicationStop, recordSyncStop } from "./git-sync-stop-actions";
import { refreshGitRemoteStatus, refreshGitStatus } from "./git-status-actions";

export interface GitCommitResult {
  status: GitStatus;
  committedPaths: string[];
}

function retainBranchError(error: unknown, spacePath: string) {
  const message = gitBranchErrorMessage(error);
  if (message) useGitStore.getState().setBranchError(spacePath, message);
}

export interface GitAutoSyncOptions {
  onSyncOutcome?: (outcome: GitSyncOutcome) => void;
}

export interface SaveGitRemoteCredentialsInput {
  remoteUrl: string;
  username: string;
  password: string;
}

export function saveGitRemoteCredentials({
  remoteUrl,
  username,
  password,
}: SaveGitRemoteCredentialsInput): Promise<void> {
  return saveGitHttpCredentials({ remoteUrl, username, password });
}

/**
 * Run pull+push for the space and return a typed outcome to callers.
 * Updates per-space syncing/error state in the git store; only an explicit
 * sync shows that it runs (Stage 11 1.E).
 */
export async function syncSpace(
  spacePath: string,
  background = false,
): Promise<GitSyncOutcome> {
  return runSync(spacePath, () => syncGit(spacePath, background), !background);
}

export async function runSync(
  spacePath: string,
  execute: () => ReturnType<typeof syncGit>,
  indicate = true,
): Promise<GitSyncOutcome> {
  const git = useGitStore.getState();
  const request = git.beginSync(spacePath, indicate);
  try {
    const dto = await execute();
    const result = toSyncResult(dto);
    if (!request.current()) return result;
    if (dto.type === "success" && dto.remoteStatus) {
      git.applyRemoteStatus(spacePath, toGitStatus(dto.remoteStatus));
    }
    recordSyncPublication(spacePath, result);
    recordSyncStop(spacePath, result);
    switch (result.type) {
      case "Success":
        if (dto.type === "success" && !dto.remoteStatus) {
          void refreshGitRemoteStatus(spacePath).catch(() => {});
        }
        if (dto.type === "success" && !dto.remoteStatus) {
          await refreshGitStatus(spacePath).catch(() => {});
        }
        return result;
      case "NoRemote":
        // Silent — no remote configured is a normal state.
        return result;
      case "Conflict":
      case "UnmergedFiles":
        await refreshGitStatus(spacePath);
        return result;
      case "OperationInProgress":
      case "IncomingConflict":
      case "ExplicitSyncRequired":
      case "Unresolved":
        // Nothing changed in the repository; the stop or finding says why.
        return result;
      case "IntegrationAfterTurn":
        // Fetched only: the counters show the incoming changes.
        void refreshGitRemoteStatus(spacePath).catch(() => {});
        return result;
      case "Resolved":
        await refreshGitStatus(spacePath);
        return result;
      case "AuthRequired":
        git.setSyncError(spacePath, "auth");
        return result;
    }
  } catch (err) {
    console.error("git_sync failed:", err);
    const branchMessage = gitBranchErrorMessage(err);
    const message = gitSyncErrorMessage(err);
    const block = toGitPublicationBlock(err) ?? undefined;
    const stop = toGitPublicationStop(err) ?? undefined;
    const failed = { type: "Failed" as const, message, block, stop };
    if (!request.current()) return failed;
    if (branchMessage) git.setBranchError(spacePath, branchMessage);
    git.setPublicationBlock(spacePath, block ?? null);
    recordPublicationStop(spacePath, stop ?? null);
    git.setSyncError(
      spacePath,
      branchMessage || block || stop ? null : message,
    );
    return failed;
  } finally {
    request.finish();
  }
}

/**
 * Stage one file, commit, then auto-sync if enabled.
 * Triggered by ⌘S after the editor wrote the file to disk.
 * When projectPath is provided, the backend routes the commit
 * to the correct repo based on the space's git type.
 */
export async function commitFileAndMaybeSync(
  spacePath: string,
  filePath: string,
  projectPath?: string,
): Promise<GitCommitResult | null> {
  let result: GitCommitResult;
  try {
    const saved = await commitGitFile({
      projectPath,
      spacePath,
      filePath,
    });
    recordSavedPublication(spacePath, saved);
    const status = toGitStatus(saved);
    useGitStore.getState().applyStatus(spacePath, status);
    result = {
      status,
      committedPaths: status.files.some((file) => file.path === filePath)
        ? []
        : [filePath],
    };
  } catch (err) {
    console.error("git_commit_file failed:", err);
    retainBranchError(err, spacePath);
    await refreshGitStatus(spacePath);
    throw err;
  }
  useGitStore.getState().setBranchError(spacePath, null);
  publishAfterCommit(spacePath);
  return result;
}

/**
 * Stage all changes, commit, then auto-sync if enabled.
 * Triggered by ⌘⇧S or by the space "Commit all" menu item.
 * When projectPath is provided, the backend routes the commit
 * to the correct repo based on the space's git type.
 */
export async function commitAllSpace(
  spacePath: string,
  projectPath?: string,
): Promise<GitCommitResult | null> {
  const previousDirtyPaths =
    useGitStore
      .getState()
      .statuses[spacePath]?.files.map((file) => file.path) ?? [];
  let result: GitCommitResult;
  try {
    const saved = await commitGitAll({
      projectPath,
      spacePath,
    });
    recordSavedPublication(spacePath, saved);
    const status = toGitStatus(saved);
    useGitStore.getState().applyStatus(spacePath, status);
    const stillDirty = new Set(
      status.files.map((file) => normalizeGitStatusPath(file.path)),
    );
    result = {
      status,
      committedPaths: previousDirtyPaths.filter(
        (path) => !stillDirty.has(path),
      ),
    };
  } catch (err) {
    console.error("git_commit_all failed:", err);
    retainBranchError(err, spacePath);
    await refreshGitStatus(spacePath);
    throw err;
  }
  useGitStore.getState().setBranchError(spacePath, null);
  publishAfterCommit(spacePath);
  return result;
}

export async function commitPathsAndMaybeSync(
  spacePath: string,
  filePaths: string[],
  projectPath?: string,
): Promise<GitCommitResult | null> {
  const targetPaths = uniqueGitStatusPaths(filePaths);
  if (targetPaths.length === 0) return null;

  const targets = new Set(targetPaths);
  const previousDirtyPaths =
    useGitStore
      .getState()
      .statuses[spacePath]?.files.map((file) => file.path)
      .filter((path) => targets.has(normalizeGitStatusPath(path))) ?? [];
  let result: GitCommitResult;
  try {
    const saved = await commitGitPaths({
      projectPath,
      spacePath,
      filePaths: targetPaths,
    });
    recordSavedPublication(spacePath, saved);
    const status = toGitStatus(saved);
    useGitStore.getState().applyStatus(spacePath, status);
    const stillDirty = new Set(status.files.map((file) => file.path));
    result = {
      status,
      committedPaths: uniqueGitStatusPaths([
        ...previousDirtyPaths,
        ...targetPaths,
      ]).filter((path) => !stillDirty.has(path)),
    };
  } catch (err) {
    console.error("git_commit_paths failed:", err);
    retainBranchError(err, spacePath);
    await refreshGitStatus(spacePath);
    throw err;
  }
  useGitStore.getState().setBranchError(spacePath, null);
  publishAfterCommit(spacePath);
  return result;
}

export async function commitSaveScopeAndMaybeSync(
  spacePath: string,
  scope: GitSaveScope,
  extraPaths: string[],
  projectPath?: string,
): Promise<GitCommitResult | null> {
  try {
    await refreshGitStatus(spacePath);
  } catch (err) {
    console.error("git_status before scoped save failed:", err);
  }

  const filePaths = dirtyPathsForGitSaveScope(
    useGitStore.getState().statuses[spacePath],
    scope,
    extraPaths,
  );
  return commitPathsAndMaybeSync(spacePath, filePaths, projectPath);
}

/**
 * Mark the resolved paths and finish the merge once no conflict remains.
 */
export async function continueGitResolve(
  spacePath: string,
  paths: string[],
  options?: GitAutoSyncOptions,
): Promise<void> {
  const outcome = await runSync(spacePath, () =>
    continuePlatformGitResolve({ spacePath, paths }),
  );
  options?.onSyncOutcome?.(outcome);
}

/**
 * «Слить служебные файлы Svode»: merge the conflicted Svode service files of
 * the merge in the repository by the rule set (all, or the
 * repository-relative `paths`), then continue the merge.
 */
export function mergeGitServiceFiles(
  repositoryPath: string,
  paths?: string[],
): Promise<GitSyncOutcome> {
  return runSync(repositoryPath, () =>
    mergePlatformGitServiceFiles({ spacePath: repositoryPath, paths }),
  );
}

/**
 * «Синхронизировать пространство» for a Space pointer the project merge left
 * in conflict: sync the Space at `pointerPath`, whose new revision then
 * contains both sides, and let the merge take it. The Space outcome comes
 * back when its own sync did not finish.
 */
export async function syncGitPointerSpace(
  repositoryPath: string,
  pointerPath: string,
): Promise<{ space: GitSyncOutcome; project?: GitSyncOutcome }> {
  const root = repositoryPath.replace(/[\\/]+$/, "");
  const space = await syncSpace(
    `${root}/${normalizeGitStatusPath(pointerPath)}`,
  );
  if (space.type !== "Success") return { space };
  return {
    space,
    project: await mergeGitServiceFiles(repositoryPath, [pointerPath]),
  };
}

/**
 * A commit landed: with sync on, its publication joins the rhythm of the
 * repository, whichever commit toggles are on (Stage 11 1.E).
 */
function publishAfterCommit(spacePath: string) {
  void triggerGitSync({ spacePath, trigger: "committed" }).catch((err) =>
    console.debug("sync after commit not planned:", err),
  );
}

function uniqueGitStatusPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = normalizeGitStatusPath(path);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}
