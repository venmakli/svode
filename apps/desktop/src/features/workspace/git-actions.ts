import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useGitStore } from "@/stores/git";
import type { SyncResult, WorkspaceGitStatus } from "@/types/git";
import type { WorkspaceConfig } from "@/types/workspace";

/**
 * Read the per-workspace `git.autoSync` setting (default: true).
 */
async function isAutoSyncEnabled(workspacePath: string): Promise<boolean> {
  try {
    const cfg = await invoke<WorkspaceConfig>("get_workspace_config", {
      workspacePath,
    });
    return cfg.git?.autoSync !== false;
  } catch {
    return true;
  }
}

/**
 * Run pull+push for the workspace and surface errors as toasts.
 * Updates per-workspace syncing/error state in the git store.
 */
export async function syncWorkspace(workspacePath: string): Promise<void> {
  const git = useGitStore.getState();
  git.setSyncing(workspacePath, true);
  git.setSyncError(workspacePath, null);
  try {
    const result = await invoke<SyncResult>("git_sync", { workspacePath });
    switch (result.type) {
      case "Success":
        // Refresh status to clear any local indicators (file `↻`).
        await git.refreshStatus(workspacePath);
        break;
      case "NoRemote":
        // Silent — no remote configured is a normal state.
        break;
      case "Conflict":
        toast.error(
          m.git_sync_conflict({ count: String(result.files.length) }),
        );
        await git.refreshStatus(workspacePath);
        git.setSyncError(workspacePath, "conflict");
        break;
      case "AuthRequired":
        toast.error(m.git_sync_auth_required());
        git.setSyncError(workspacePath, "auth");
        break;
    }
  } catch (err) {
    console.error("git_sync failed:", err);
    toast.error(m.git_sync_failed());
    git.setSyncError(workspacePath, String(err));
  } finally {
    git.setSyncing(workspacePath, false);
  }
}

/**
 * Stage one file, commit, then auto-sync if enabled.
 * Triggered by ⌘S after the editor wrote the file to disk.
 */
export async function commitFileAndMaybeSync(
  workspacePath: string,
  filePath: string,
): Promise<void> {
  try {
    const status = await invoke<WorkspaceGitStatus>("git_commit_file", {
      workspacePath,
      filePath,
    });
    useGitStore.getState().applyStatus(workspacePath, status);
  } catch (err) {
    console.error("git_commit_file failed:", err);
    return;
  }
  if (await isAutoSyncEnabled(workspacePath)) {
    void syncWorkspace(workspacePath);
  }
}

/**
 * Stage all changes, commit, then auto-sync if enabled.
 * Triggered by ⌘⇧S or by the workspace "Save all" menu item.
 */
export async function commitAllWorkspace(workspacePath: string): Promise<void> {
  try {
    const status = await invoke<WorkspaceGitStatus>("git_commit_all", {
      workspacePath,
    });
    useGitStore.getState().applyStatus(workspacePath, status);
  } catch (err) {
    console.error("git_commit_all failed:", err);
    return;
  }
  if (await isAutoSyncEnabled(workspacePath)) {
    void syncWorkspace(workspacePath);
  }
}

/**
 * Sync on workspace open. Silent on failure (no remote / offline / auth).
 */
export async function syncOnOpen(workspacePath: string): Promise<void> {
  if (!(await isAutoSyncEnabled(workspacePath))) return;
  const git = useGitStore.getState();
  git.setSyncing(workspacePath, true);
  // Clear any stuck error from a previous session — a fresh open should
  // re-evaluate the state rather than show the last failure forever.
  git.setSyncError(workspacePath, null);
  try {
    const result = await invoke<SyncResult>("git_sync", { workspacePath });
    if (result.type === "Success") {
      await git.refreshStatus(workspacePath);
    }
  } catch (err) {
    console.debug("sync on open failed (silent):", err);
  } finally {
    git.setSyncing(workspacePath, false);
  }
}
