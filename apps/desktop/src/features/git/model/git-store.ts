import { create } from "zustand";
import { getGitStatus } from "@/platform/git/git-api";
import type { GitStatus } from "./types";

/**
 * Per-space git state.
 *
 * Sources of truth:
 * - `statuses` is the latest `git status` snapshot per space path.
 * - `syncing` flags spaces in the middle of a pull/push.
 * - `cloning` tracks in-progress `git clone` operations and their percent.
 * - `syncError` is set when sync fails (auth/network) → indicator goes to `✕`.
 */
interface GitState {
  statuses: Record<string, GitStatus>;
  syncing: Record<string, boolean>;
  syncError: Record<string, string>;
  cloning: Record<string, { phase: string; percent: number; error?: string }>;

  /** Apply a status returned by a git IPC command. */
  applyStatus: (spacePath: string, status: GitStatus) => void;
  /** Fetch fresh status via `git_status`. */
  refreshStatus: (spacePath: string) => Promise<void>;
  /** Clear local state for a removed space. */
  clear: (spacePath: string) => void;

  setSyncing: (spacePath: string, syncing: boolean) => void;
  setSyncError: (spacePath: string, error: string | null) => void;

  setCloning: (
    spacePath: string,
    progress: { phase: string; percent: number; error?: string } | null,
  ) => void;
}

export const useGitStore = create<GitState>((set) => ({
  statuses: {},
  syncing: {},
  syncError: {},
  cloning: {},

  applyStatus: (spacePath, status) =>
    set((s) => ({
      statuses: { ...s.statuses, [spacePath]: status },
    })),

  refreshStatus: async (spacePath) => {
    try {
      const status = await getGitStatus(spacePath);
      set((s) => ({
        statuses: { ...s.statuses, [spacePath]: status },
      }));
    } catch (err) {
      // Space may not have git initialized yet — leave previous status alone
      console.debug("git_status failed for", spacePath, err);
    }
  },

  clear: (spacePath) =>
    set((s) => {
      const { [spacePath]: _rmStatus, ...statuses } = s.statuses;
      const { [spacePath]: _rmSync, ...syncing } = s.syncing;
      const { [spacePath]: _rmError, ...syncError } = s.syncError;
      const { [spacePath]: _rmClone, ...cloning } = s.cloning;
      return { statuses, syncing, syncError, cloning };
    }),

  setSyncing: (spacePath, syncing) =>
    set((s) => {
      const next = { ...s.syncing };
      if (syncing) next[spacePath] = true;
      else delete next[spacePath];
      return { syncing: next };
    }),

  setSyncError: (spacePath, error) =>
    set((s) => {
      const next = { ...s.syncError };
      if (error) next[spacePath] = error;
      else delete next[spacePath];
      return { syncError: next };
    }),

  setCloning: (spacePath, progress) =>
    set((s) => {
      const next = { ...s.cloning };
      if (progress) next[spacePath] = progress;
      else delete next[spacePath];
      return { cloning: next };
    }),
}));

/** Convenience derived selectors. */
export type GitIndicator =
  | "clean"
  | "dirty"
  | "syncing"
  | "conflict"
  | "error"
  | "cloning";

export function selectIndicator(
  state: GitState,
  spacePath: string,
): GitIndicator {
  const cloning = state.cloning[spacePath];
  // A failed clone leaves `cloning.error` populated until the user dismisses
  // it — show `error` (✕) rather than keeping the spinner.
  if (cloning) return cloning.error ? "error" : "cloning";
  if (state.syncError[spacePath]) return "error";
  const status = state.statuses[spacePath];
  if (status?.hasConflicts) return "conflict";
  if (state.syncing[spacePath]) return "syncing";
  if (status && (status.hasStaged || status.hasUnstaged)) return "dirty";
  return "clean";
}

export function selectFileIndicator(
  state: GitState,
  spacePath: string,
  filePath: string,
): "clean" | "dirty" | "conflict" | "syncing" {
  const status = state.statuses[spacePath];
  if (!status) return "clean";
  const file = status.files.find((f) => f.path === filePath);
  if (!file) return "clean";
  if (file.state === "conflict") return "conflict";
  if (state.syncing[spacePath]) return "syncing";
  return "dirty";
}
