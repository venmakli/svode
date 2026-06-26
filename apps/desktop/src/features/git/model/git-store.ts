import { create } from "zustand";
import type {
  FileGitState,
  FileGitStatus,
  GitCloneProgress,
  GitStatus,
} from "./types";

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
  cloning: Record<string, GitCloneProgress>;

  /** Apply a status returned by a git IPC command. */
  applyStatus: (spacePath: string, status: GitStatus) => void;
  /** Fetch fresh status through the feature API while guarding stale responses. */
  refreshStatus: (
    spacePath: string,
    loadStatus: () => Promise<GitStatus>,
  ) => Promise<void>;
  /** Clear local state for a removed space. */
  clear: (spacePath: string) => void;

  setSyncing: (spacePath: string, syncing: boolean) => void;
  setSyncError: (spacePath: string, error: string | null) => void;

  setCloning: (spacePath: string, progress: GitCloneProgress | null) => void;
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

    refreshStatus: async (spacePath, loadStatus) => {
      const version = (refreshVersions[spacePath] ?? 0) + 1;
      refreshVersions[spacePath] = version;
      try {
        const status = await loadStatus();
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
  | {
      kind: "dirty";
      reason: "git_dirty" | "pending_write";
      scope: "self" | "descendants" | "mixed";
      state?: FileGitState;
    }
  | { kind: "syncing" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface GitTreeNodeIndicatorTarget {
  path: string;
  hasSchema?: boolean;
  isContainer?: boolean;
  pendingWrite?: boolean;
}

type DirtyFileChangeIndicator = Extract<FileChangeIndicator, { kind: "dirty" }>;
type DirtyFileChangeReason = DirtyFileChangeIndicator["reason"];
type DirtyFileChangeScope = DirtyFileChangeIndicator["scope"];

const CLEAN_FILE_INDICATOR: FileChangeIndicator = { kind: "clean" };
const SYNCING_FILE_INDICATOR: FileChangeIndicator = { kind: "syncing" };
const CONFLICT_FILE_INDICATOR: FileChangeIndicator = { kind: "conflict" };
const DIRTY_FILE_INDICATORS = new Map<string, DirtyFileChangeIndicator>();

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
  return selectFileTargetChangeIndicator(state, spacePath, {
    selfPaths: [filePath],
    pendingWrite,
  });
}

export function selectTreeNodeChangeIndicator(
  state: GitState,
  spacePath: string,
  target: GitTreeNodeIndicatorTarget,
): FileChangeIndicator {
  const nodePath = normalizeGitStatusPath(target.path);
  const containerPath = target.isContainer
    ? containerPathForNodePath(nodePath)
    : null;
  const selfPaths = [nodePath];
  if (target.hasSchema && containerPath !== null) {
    selfPaths.push(joinGitStatusPath(containerPath, "schema.yaml"));
  }

  return selectFileTargetChangeIndicator(state, spacePath, {
    selfPaths,
    descendantPath: containerPath,
    pendingWrite: target.pendingWrite,
  });
}

export function selectSpaceRootChangeIndicator(
  state: GitState,
  spacePath: string,
): FileChangeIndicator {
  return selectFileTargetChangeIndicator(state, spacePath, {
    selfPaths: ["README.md"],
    selfPathPrefixes: [".svode/"],
    descendantPath: "",
  });
}

interface FileTargetChangeInput {
  selfPaths: string[];
  selfPathPrefixes?: string[];
  descendantPath?: string | null;
  pendingWrite?: boolean;
}

function selectFileTargetChangeIndicator(
  state: GitState,
  spacePath: string,
  target: FileTargetChangeInput,
): FileChangeIndicator {
  const status = state.statuses[spacePath];
  const selfPaths = new Set(target.selfPaths.map(normalizeGitStatusPath));
  const selfPathPrefixes = (target.selfPathPrefixes ?? []).map(
    normalizeGitStatusPrefix,
  );
  const descendantPath =
    target.descendantPath == null
      ? null
      : normalizeGitStatusPath(target.descendantPath);

  const selfFiles: FileGitStatus[] = [];
  const descendantFiles: FileGitStatus[] = [];

  for (const file of status?.files ?? []) {
    const filePath = normalizeGitStatusPath(file.path);
    if (isSelfPath(filePath, selfPaths, selfPathPrefixes)) {
      selfFiles.push(file);
    } else if (
      descendantPath !== null &&
      isGitStatusPathDescendant(filePath, descendantPath)
    ) {
      descendantFiles.push(file);
    }
  }

  if (
    selfFiles.some((file) => file.state === "conflict") ||
    descendantFiles.some((file) => file.state === "conflict")
  ) {
    return CONFLICT_FILE_INDICATOR;
  }

  const hasSelfChanges = selfFiles.length > 0 || target.pendingWrite === true;
  const hasDescendantChanges = descendantFiles.length > 0;
  if (hasSelfChanges || hasDescendantChanges) {
    const scope =
      hasSelfChanges && hasDescendantChanges
        ? "mixed"
        : hasSelfChanges
          ? "self"
          : "descendants";
    const firstFile = selfFiles[0] ?? descendantFiles[0];
    return dirtyFileChangeIndicator(
      target.pendingWrite && selfFiles.length === 0
        ? "pending_write"
        : "git_dirty",
      scope,
      firstFile?.state,
    );
  }

  if (state.syncing[spacePath]) return SYNCING_FILE_INDICATOR;
  return CLEAN_FILE_INDICATOR;
}

function dirtyFileChangeIndicator(
  reason: DirtyFileChangeReason,
  scope: DirtyFileChangeScope,
  state: FileGitState | undefined,
): DirtyFileChangeIndicator {
  const key = `${reason}:${scope}:${state ?? ""}`;
  const cached = DIRTY_FILE_INDICATORS.get(key);
  if (cached) return cached;

  const indicator: DirtyFileChangeIndicator = {
    kind: "dirty",
    reason,
    scope,
    ...(state === undefined ? {} : { state }),
  };
  DIRTY_FILE_INDICATORS.set(key, indicator);
  return indicator;
}

function normalizeGitStatusPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function normalizeGitStatusPrefix(path: string): string {
  const normalized = normalizeGitStatusPath(path);
  return normalized ? `${normalized.replace(/\/+$/g, "")}/` : "";
}

function basename(path: string): string {
  const normalized = normalizeGitStatusPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function dirname(path: string): string {
  const normalized = normalizeGitStatusPath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function isReadmePath(path: string): boolean {
  return basename(path).toLowerCase() === "readme.md";
}

function containerPathForNodePath(path: string): string {
  if (!path.endsWith(".md")) return path;
  if (isReadmePath(path)) return dirname(path);
  return dirname(path);
}

function joinGitStatusPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function isSelfPath(
  path: string,
  selfPaths: Set<string>,
  selfPathPrefixes: string[],
): boolean {
  return (
    selfPaths.has(path) ||
    selfPathPrefixes.some((prefix) => prefix !== "" && path.startsWith(prefix))
  );
}

function isGitStatusPathDescendant(path: string, parentPath: string): boolean {
  if (!parentPath) return path !== "";
  return path.startsWith(`${parentPath}/`);
}
