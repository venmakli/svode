import { invokeCommand as invoke } from "@/platform/native/invoke";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useEditorStore } from "@/features/editor/model";
import { useGitStore } from "../model";
import type { SyncResult, GitStatus } from "../model";
import type { SpaceConfig } from "@/features/space/model";

/**
 * Read the per-space `git.autoSync` setting (default: false).
 */
async function isAutoSyncEnabled(spacePath: string): Promise<boolean> {
  try {
    const cfg = await invoke<SpaceConfig>("get_space_config", {
      spacePath,
    });
    return cfg.git?.autoSync === true;
  } catch {
    return false;
  }
}

function clearCommittedReviewMarkers(paths: string[]) {
  if (paths.length === 0) return;
  const editor = useEditorStore.getState();
  for (const path of paths) {
    editor.clearAiModified(path);
  }
}

/**
 * Run pull+push for the space and surface errors as toasts.
 * Updates per-space syncing/error state in the git store.
 */
export async function syncSpace(spacePath: string): Promise<void> {
  const git = useGitStore.getState();
  git.setSyncing(spacePath, true);
  git.setSyncError(spacePath, null);
  try {
    const result = await invoke<SyncResult>("git_sync", { spacePath });
    switch (result.type) {
      case "Success":
        // Refresh status to clear any local indicators (file `↻`).
        await git.refreshStatus(spacePath);
        break;
      case "NoRemote":
        // Silent — no remote configured is a normal state.
        break;
      case "Conflict":
        toast.error(
          m.git_sync_conflict({ count: String(result.files.length) }),
        );
        await git.refreshStatus(spacePath);
        git.setSyncError(spacePath, "conflict");
        break;
      case "AuthRequired":
        toast.error(m.git_sync_auth_required());
        git.setSyncError(spacePath, "auth");
        break;
    }
  } catch (err) {
    console.error("git_sync failed:", err);
    toast.error(m.git_sync_failed());
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
): Promise<void> {
  try {
    const status = await invoke<GitStatus>("git_commit_file", {
      projectPath: projectPath ?? null,
      spacePath,
      filePath,
    });
    useGitStore.getState().applyStatus(spacePath, status);
    if (!status.files.some((file) => file.path === filePath)) {
      clearCommittedReviewMarkers([filePath]);
    }
  } catch (err) {
    console.error("git_commit_file failed:", err);
    return;
  }
  if (await isAutoSyncEnabled(spacePath)) {
    void syncSpace(spacePath);
  }
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
): Promise<void> {
  const previousDirtyPaths =
    useGitStore.getState().statuses[spacePath]?.files.map((file) => file.path) ??
    [];
  try {
    const status = await invoke<GitStatus>("git_commit_all", {
      projectPath: projectPath ?? null,
      spacePath,
    });
    useGitStore.getState().applyStatus(spacePath, status);
    const stillDirty = new Set(status.files.map((file) => file.path));
    clearCommittedReviewMarkers(
      previousDirtyPaths.filter((path) => !stillDirty.has(path)),
    );
  } catch (err) {
    console.error("git_commit_all failed:", err);
    return;
  }
  if (await isAutoSyncEnabled(spacePath)) {
    void syncSpace(spacePath);
  }
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
    const result = await invoke<SyncResult>("git_sync", { spacePath });
    if (result.type === "Success") {
      await git.refreshStatus(spacePath);
    }
  } catch (err) {
    console.debug("sync on open failed (silent):", err);
  } finally {
    git.setSyncing(spacePath, false);
  }
}
