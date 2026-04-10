import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceGitStatus } from "@/types/git";

/**
 * Per-workspace git state.
 *
 * Sources of truth:
 * - `statuses` is the latest `git status` snapshot per workspace path.
 * - `syncing` flags workspaces in the middle of a pull/push.
 * - `cloning` tracks in-progress `git clone` operations and their percent.
 * - `syncError` is set when sync fails (auth/network) → indicator goes to `✕`.
 */
interface GitState {
  statuses: Record<string, WorkspaceGitStatus>;
  syncing: Record<string, boolean>;
  syncError: Record<string, string>;
  cloning: Record<string, { phase: string; percent: number; error?: string }>;

  /** Apply a status returned by a git IPC command. */
  applyStatus: (workspacePath: string, status: WorkspaceGitStatus) => void;
  /** Fetch fresh status via `git_status`. */
  refreshStatus: (workspacePath: string) => Promise<void>;
  /** Clear local state for a removed workspace. */
  clear: (workspacePath: string) => void;

  setSyncing: (workspacePath: string, syncing: boolean) => void;
  setSyncError: (workspacePath: string, error: string | null) => void;

  setCloning: (
    workspacePath: string,
    progress: { phase: string; percent: number; error?: string } | null,
  ) => void;
}

export const useGitStore = create<GitState>((set) => ({
  statuses: {},
  syncing: {},
  syncError: {},
  cloning: {},

  applyStatus: (workspacePath, status) =>
    set((s) => ({
      statuses: { ...s.statuses, [workspacePath]: status },
    })),

  refreshStatus: async (workspacePath) => {
    try {
      const status = await invoke<WorkspaceGitStatus>("git_status", {
        workspacePath,
      });
      set((s) => ({
        statuses: { ...s.statuses, [workspacePath]: status },
      }));
    } catch (err) {
      // Workspace may not have git initialized yet — leave previous status alone
      console.debug("git_status failed for", workspacePath, err);
    }
  },

  clear: (workspacePath) =>
    set((s) => {
      const { [workspacePath]: _s, ...statuses } = s.statuses;
      const { [workspacePath]: _sy, ...syncing } = s.syncing;
      const { [workspacePath]: _e, ...syncError } = s.syncError;
      const { [workspacePath]: _c, ...cloning } = s.cloning;
      return { statuses, syncing, syncError, cloning };
    }),

  setSyncing: (workspacePath, syncing) =>
    set((s) => {
      const next = { ...s.syncing };
      if (syncing) next[workspacePath] = true;
      else delete next[workspacePath];
      return { syncing: next };
    }),

  setSyncError: (workspacePath, error) =>
    set((s) => {
      const next = { ...s.syncError };
      if (error) next[workspacePath] = error;
      else delete next[workspacePath];
      return { syncError: next };
    }),

  setCloning: (workspacePath, progress) =>
    set((s) => {
      const next = { ...s.cloning };
      if (progress) next[workspacePath] = progress;
      else delete next[workspacePath];
      return { cloning: next };
    }),
}));

/** Convenience derived selectors. */
export type WorkspaceGitIndicator =
  | "clean"
  | "dirty"
  | "syncing"
  | "conflict"
  | "error"
  | "cloning";

export function selectIndicator(
  state: GitState,
  workspacePath: string,
): WorkspaceGitIndicator {
  const cloning = state.cloning[workspacePath];
  // A failed clone leaves `cloning.error` populated until the user dismisses
  // it — show `error` (✕) rather than keeping the spinner.
  if (cloning) return cloning.error ? "error" : "cloning";
  if (state.syncError[workspacePath]) return "error";
  const status = state.statuses[workspacePath];
  if (status?.hasConflicts) return "conflict";
  if (state.syncing[workspacePath]) return "syncing";
  if (status && (status.hasStaged || status.hasUnstaged)) return "dirty";
  return "clean";
}

export function selectFileIndicator(
  state: GitState,
  workspacePath: string,
  filePath: string,
): "clean" | "dirty" | "conflict" | "syncing" {
  const status = state.statuses[workspacePath];
  if (!status) return "clean";
  const file = status.files.find((f) => f.path === filePath);
  if (!file) return "clean";
  if (file.state === "conflict") return "conflict";
  if (state.syncing[workspacePath]) return "syncing";
  return "dirty";
}
