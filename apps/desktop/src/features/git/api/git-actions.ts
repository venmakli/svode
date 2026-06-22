import { useGitStore } from "../model";
import {
  commitGitAll,
  commitGitFile,
  continueGitResolve as continuePlatformGitResolve,
  syncGit,
} from "@/platform/git/git-api";
import { getSpaceConfig } from "@/platform/space/space-api";
import type { GitStatus } from "../model";
import { refreshGitStatus } from "./git-status-actions";
import {
  notifyGitSyncAuthRequired,
  notifyGitSyncConflict,
  notifyGitSyncFailed,
} from "../effects/git-notifications";

export interface GitCommitResult {
  status: GitStatus;
  committedPaths: string[];
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
 * Run pull+push for the space and surface errors through feature effects.
 * Updates per-space syncing/error state in the git store.
 */
export async function syncSpace(spacePath: string): Promise<void> {
  const git = useGitStore.getState();
  git.setSyncing(spacePath, true);
  git.setSyncError(spacePath, null);
  try {
    const result = await syncGit(spacePath);
    switch (result.type) {
      case "Success":
        // Refresh status to clear any local indicators (file `↻`).
        await refreshGitStatus(spacePath);
        break;
      case "NoRemote":
        // Silent — no remote configured is a normal state.
        break;
      case "Conflict":
        notifyGitSyncConflict(result.files.length);
        await refreshGitStatus(spacePath);
        git.setSyncError(spacePath, "conflict");
        break;
      case "AuthRequired":
        notifyGitSyncAuthRequired();
        git.setSyncError(spacePath, "auth");
        break;
    }
  } catch (err) {
    console.error("git_sync failed:", err);
    notifyGitSyncFailed();
    git.setSyncError(spacePath, String(err));
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
): Promise<GitCommitResult | null> {
  let result: GitCommitResult;
  try {
    const status = await commitGitFile({
      projectPath,
      spacePath,
      filePath,
    });
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
    void syncSpace(spacePath);
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
): Promise<GitCommitResult | null> {
  const previousDirtyPaths =
    useGitStore.getState().statuses[spacePath]?.files.map((file) => file.path) ??
    [];
  let result: GitCommitResult;
  try {
    const status = await commitGitAll({
      projectPath,
      spacePath,
    });
    useGitStore.getState().applyStatus(spacePath, status);
    const stillDirty = new Set(status.files.map((file) => file.path));
    result = {
      status,
      committedPaths: previousDirtyPaths.filter((path) => !stillDirty.has(path)),
    };
  } catch (err) {
    console.error("git_commit_all failed:", err);
    return null;
  }
  if (await isAutoSyncEnabled(spacePath)) {
    void syncSpace(spacePath);
  }
  return result;
}

export async function continueGitResolve(spacePath: string): Promise<void> {
  await continuePlatformGitResolve(spacePath);
  await refreshGitStatus(spacePath);
  void syncSpace(spacePath);
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
    const result = await syncGit(spacePath);
    if (result.type === "Success") {
      await refreshGitStatus(spacePath);
    }
  } catch (err) {
    console.debug("sync on open failed (silent):", err);
  } finally {
    git.setSyncing(spacePath, false);
  }
}
