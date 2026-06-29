import { useGitStore } from "../model";
import {
  commitGitAll,
  commitGitFile,
  commitGitPaths,
  continueGitResolve as continuePlatformGitResolve,
  syncGit,
} from "@/platform/git/git-api";
import { getSpaceConfig } from "@/platform/space/space-api";
import {
  dirtyPathsForGitSaveScope,
  normalizeGitStatusPath,
  type GitSaveScope,
  type GitStatus,
  type GitSyncOutcome,
} from "../model";
import { toGitStatus, toSyncResult } from "./git-mappers";
import { refreshGitStatus } from "./git-status-actions";

export interface GitCommitResult {
  status: GitStatus;
  committedPaths: string[];
}

export interface GitAutoSyncOptions {
  onSyncOutcome?: (outcome: GitSyncOutcome) => void;
}

function runAutoSync(spacePath: string, options?: GitAutoSyncOptions): void {
  void syncSpace(spacePath).then((outcome) => {
    options?.onSyncOutcome?.(outcome);
  });
}

/**
 * Read the per-space `git.autoSync` setting (default: false).
 */
export async function isAutoSyncEnabled(spacePath: string): Promise<boolean> {
  try {
    const cfg = await getSpaceConfig(spacePath);
    return cfg.git?.autoSync === true;
  } catch {
    return false;
  }
}

/**
 * Run pull+push for the space and return a typed outcome to callers.
 * Updates per-space syncing/error state in the git store.
 */
export async function syncSpace(spacePath: string): Promise<GitSyncOutcome> {
  const git = useGitStore.getState();
  git.setSyncing(spacePath, true);
  git.setSyncError(spacePath, null);
  try {
    const result = toSyncResult(await syncGit(spacePath));
    switch (result.type) {
      case "Success":
        // Refresh status to clear any local indicators (file `↻`).
        await refreshGitStatus(spacePath);
        return result;
      case "NoRemote":
        // Silent — no remote configured is a normal state.
        return result;
      case "Conflict":
        await refreshGitStatus(spacePath);
        git.setSyncError(spacePath, "conflict");
        return result;
      case "AuthRequired":
        git.setSyncError(spacePath, "auth");
        return result;
    }
  } catch (err) {
    console.error("git_sync failed:", err);
    const message = String(err);
    git.setSyncError(spacePath, message);
    return { type: "Failed", message };
  } finally {
    git.setSyncing(spacePath, false);
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
  options?: GitAutoSyncOptions,
): Promise<GitCommitResult | null> {
  let result: GitCommitResult;
  try {
    const status = toGitStatus(
      await commitGitFile({
        projectPath,
        spacePath,
        filePath,
      }),
    );
    useGitStore.getState().applyStatus(spacePath, status);
    result = {
      status,
      committedPaths: status.files.some((file) => file.path === filePath)
        ? []
        : [filePath],
    };
  } catch (err) {
    console.error("git_commit_file failed:", err);
    return null;
  }
  if (await isAutoSyncEnabled(spacePath)) {
    runAutoSync(spacePath, options);
  }
  return result;
}

/**
 * Stage all changes, commit, then auto-sync if enabled.
 * Triggered by ⌘⇧S or by the space "Save all" menu item.
 * When projectPath is provided, the backend routes the commit
 * to the correct repo based on the space's git type.
 */
export async function commitAllSpace(
  spacePath: string,
  projectPath?: string,
  options?: GitAutoSyncOptions,
): Promise<GitCommitResult | null> {
  const previousDirtyPaths =
    useGitStore.getState().statuses[spacePath]?.files.map((file) => file.path) ??
    [];
  let result: GitCommitResult;
  try {
    const status = toGitStatus(
      await commitGitAll({
        projectPath,
        spacePath,
      }),
    );
    useGitStore.getState().applyStatus(spacePath, status);
    const stillDirty = new Set(
      status.files.map((file) => normalizeGitStatusPath(file.path)),
    );
    result = {
      status,
      committedPaths: previousDirtyPaths.filter((path) => !stillDirty.has(path)),
    };
  } catch (err) {
    console.error("git_commit_all failed:", err);
    return null;
  }
  if (await isAutoSyncEnabled(spacePath)) {
    runAutoSync(spacePath, options);
  }
  return result;
}

export async function commitPathsAndMaybeSync(
  spacePath: string,
  filePaths: string[],
  projectPath?: string,
  options?: GitAutoSyncOptions,
): Promise<GitCommitResult | null> {
  const targetPaths = uniqueGitStatusPaths(filePaths);
  if (targetPaths.length === 0) return null;

  const previousDirtyPaths =
    useGitStore
      .getState()
      .statuses[spacePath]?.files.map((file) => file.path)
      .filter((path) => targetPaths.includes(normalizeGitStatusPath(path))) ??
    [];
  let result: GitCommitResult;
  try {
    const status = toGitStatus(
      await commitGitPaths({
        projectPath,
        spacePath,
        filePaths: targetPaths,
      }),
    );
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
    return null;
  }
  if (await isAutoSyncEnabled(spacePath)) {
    runAutoSync(spacePath, options);
  }
  return result;
}

export async function commitSaveScopeAndMaybeSync(
  spacePath: string,
  scope: GitSaveScope,
  extraPaths: string[],
  projectPath?: string,
  options?: GitAutoSyncOptions,
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
  return commitPathsAndMaybeSync(spacePath, filePaths, projectPath, options);
}

export async function continueGitResolve(
  spacePath: string,
  options?: GitAutoSyncOptions,
): Promise<void> {
  await continuePlatformGitResolve(spacePath);
  await refreshGitStatus(spacePath);
  runAutoSync(spacePath, options);
}

/**
 * Sync on space open. Silent on failure (no remote / offline / auth).
 */
export async function syncOnOpen(spacePath: string): Promise<void> {
  if (!(await isAutoSyncEnabled(spacePath))) return;
  const git = useGitStore.getState();
  git.setSyncing(spacePath, true);
  // Clear any stuck error from a previous session — a fresh open should
  // re-evaluate the state rather than show the last failure forever.
  git.setSyncError(spacePath, null);
  try {
    const result = toSyncResult(await syncGit(spacePath));
    if (result.type === "Success") {
      await refreshGitStatus(spacePath);
    }
  } catch (err) {
    console.debug("sync on open failed (silent):", err);
  } finally {
    git.setSyncing(spacePath, false);
  }
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
