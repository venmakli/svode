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

export const useGitStore = create<GitState>((set) => {
  const refreshVersions: Record<string, number> = {};

  return {
    statuses: {},
    syncing: {},
    syncError: {},
    cloning: {},

    applyStatus: (spacePath, status) => {
      refreshVersions[spacePath] = (refreshVersions[spacePath] ?? 0) + 1;
      set((s) => ({
        statuses: { ...s.statuses, [spacePath]: status },
      }));
    },

    refreshStatus: async (spacePath) => {
      const version = (refreshVersions[spacePath] ?? 0) + 1;
      refreshVersions[spacePath] = version;
      try {
        const status = await getGitStatus(spacePath);
        if (refreshVersions[spacePath] !== version) return;
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
        delete refreshVersions[spacePath];
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
  };
});

/** Convenience derived selectors. */
export type GitIndicator =
  | "clean"
  | "dirty"
  | "syncing"
  | "conflict"
  | "error"
  | "cloning";

export type FileChangeIndicator =
  | { kind: "clean" }
  | { kind: "dirty"; reason: "git_dirty" | "pending_write" }
  | { kind: "syncing" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

const CLEAN_FILE_INDICATOR: FileChangeIndicator = { kind: "clean" };
const GIT_DIRTY_FILE_INDICATOR: FileChangeIndicator = {
  kind: "dirty",
  reason: "git_dirty",
};
const PENDING_WRITE_FILE_INDICATOR: FileChangeIndicator = {
  kind: "dirty",
  reason: "pending_write",
};
const SYNCING_FILE_INDICATOR: FileChangeIndicator = { kind: "syncing" };
const CONFLICT_FILE_INDICATOR: FileChangeIndicator = { kind: "conflict" };

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
  const indicator = selectFileChangeIndicator(state, spacePath, filePath);
  return indicator.kind === "error" ? "clean" : indicator.kind;
}

export function selectFileChangeIndicator(
  state: GitState,
  spacePath: string,
  filePath: string,
  pendingWrite = false,
): FileChangeIndicator {
  const status = state.statuses[spacePath];
  const file = status?.files.find((f) => f.path === filePath);
  if (file?.state === "conflict") return CONFLICT_FILE_INDICATOR;
  if (file) return GIT_DIRTY_FILE_INDICATOR;
  if (pendingWrite) return PENDING_WRITE_FILE_INDICATOR;
  if (state.syncing[spacePath]) return SYNCING_FILE_INDICATOR;
  return CLEAN_FILE_INDICATOR;
}
