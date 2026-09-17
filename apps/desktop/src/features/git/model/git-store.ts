import { create } from "zustand";
import type {
  FileGitState,
  FileGitStatus,
  GitCloneProgress,
  GitStatus,
  GitPublicationStatus,
} from "./types";
import {
  containerPathForNodePath,
  isGitStatusPathDescendant,
  normalizeGitStatusPath,
} from "./git-paths";

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
  publications: Record<string, GitPublicationStatus>;
  beginPublicationRead: (path: string) => () => boolean;
  setPublication: (
    path: string,
    publication: GitPublicationStatus | null,
  ) => void;
  statuses: Record<string, GitStatus>;
  statusErrors: Record<string, boolean>;
  syncing: Record<string, boolean>;
  backendSyncing: Record<string, boolean>;
  updateBackendSyncing: (path: string, active: boolean) => void;
  syncError: Record<string, string>;
  remoteError: Record<string, string>;
  remoteChecked: Record<string, boolean>;
  remoteStatuses: Record<string, GitStatus>;
  applyRemoteStatus: (path: string, status: GitStatus) => void;
  refreshRemoteStatus: (
    path: string,
    load: () => Promise<GitStatus>,
    message: (error: unknown) => string,
    local: () => Promise<GitStatus>,
  ) => Promise<GitStatus>;
  beginSync: (path: string) => { current: () => boolean; finish: () => void };
  branchError: Record<string, string>;
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
  setRemoteError: (spacePath: string, error: string | null) => void;

  setBranchError: (spacePath: string, error: string | null) => void;

  setCloning: (spacePath: string, progress: GitCloneProgress | null) => void;
}

export const useGitStore = create<GitState>((set, get) => {
  let remoteVersion = 0;
  let publicationVersion = 0;
  const refreshVersions: Record<string, number> = {};
  const remoteVersions: Record<string, number> = {};
  const publicationVersions: Record<string, number> = {};
  const backendRequests: Record<string, number> = {};
  const syncRequests: Record<string, { count: number; version: number }> = {};

  return {
    publications: {},
    beginPublicationRead: (path) => {
      const repository = get().statuses[path]?.repository ?? path;
      const version = ++publicationVersion;
      publicationVersions[path] = version;
      publicationVersions[repository] = version;
      return () =>
        publicationVersions[path] === version &&
        (publicationVersions[get().statuses[path]?.repository ?? path] ?? 0) <=
          version;
    },
    setPublication: (path, publication) => {
      path = get().statuses[path]?.repository ?? path;
      publicationVersions[path] = ++publicationVersion;
      set((s) => {
        const publications = { ...s.publications };
        if (publication) publications[path] = publication;
        else delete publications[path];
        return { publications };
      });
    },
    statuses: {},
    statusErrors: {},
    syncing: {},
    backendSyncing: {},
    updateBackendSyncing: (path, active) => {
      backendRequests[path] = Math.max(
        0,
        (backendRequests[path] ?? 0) + (active ? 1 : -1),
      );
      set((s) => ({
        backendSyncing: {
          ...s.backendSyncing,
          [path]: backendRequests[path] > 0,
        },
      }));
    },
    syncError: {},
    remoteError: {},
    remoteChecked: {},
    remoteStatuses: {},
    branchError: {},
    cloning: {},

    beginSync: (path) => {
      const pending = (syncRequests[path] ??= { count: 0, version: 0 });
      pending.count++;
      const version = ++pending.version;
      get().setSyncing(path, true);
      get().setSyncError(path, null);
      get().setBranchError(path, null);
      return {
        current: () =>
          syncRequests[path] === pending && pending.version === version,
        finish: () => {
          if (syncRequests[path] !== pending) return;
          if (--pending.count === 0) {
            delete syncRequests[path];
            get().setSyncing(path, false);
          }
        },
      };
    },

    applyRemoteStatus: (path, status) => {
      const repository =
        status.repository ?? get().statuses[path]?.repository ?? path;
      remoteVersions[repository] = ++remoteVersion;
      get().applyStatus(path, status);
      get().setRemoteError(path, null);
      set((s) => ({
        remoteChecked: { ...s.remoteChecked, [repository]: true },
        remoteStatuses: { ...s.remoteStatuses, [repository]: status },
      }));
    },

    refreshRemoteStatus: async (path, load, message, local) => {
      const repository = get().statuses[path]?.repository ?? path;
      const version = ++remoteVersion;
      remoteVersions[repository] = version;
      // The first response may discover the canonical repository identity.
      // A newer repository outcome still wins over that display-path request.
      const pathVersion = remoteVersions[path];
      const current = (resolved: string) =>
        remoteVersions[path] === pathVersion &&
        remoteVersions[repository] === version &&
        (remoteVersions[resolved] ?? 0) <= version;
      const statusVersion = refreshVersions[path];
      try {
        let status = await load();
        if (
          current(status.repository ?? repository) &&
          refreshVersions[path] !== statusVersion
        )
          status = await local();
        const resolved = status.repository ?? repository;
        if (current(resolved)) {
          remoteVersions[resolved] = version;
          get().applyStatus(path, status);
          get().setRemoteError(path, null);
          set((s) => ({
            remoteChecked: { ...s.remoteChecked, [resolved]: true },
            remoteStatuses: { ...s.remoteStatuses, [resolved]: status },
          }));
        }
        return status;
      } catch (error) {
        if (current(get().statuses[path]?.repository ?? repository))
          get().setRemoteError(path, message(error));
        throw error;
      }
    },

    applyStatus: (spacePath, status) => {
      const repository =
        status.repository ?? get().statuses[spacePath]?.repository;
      if (repository && !status.repository) status = { ...status, repository };
      refreshVersions[spacePath] = (refreshVersions[spacePath] ?? 0) + 1;
      set((s) => ({
        statuses: { ...s.statuses, [spacePath]: status },
        statusErrors: { ...s.statusErrors, [spacePath]: false },
        publications: repositoryState(
          s.publications,
          spacePath,
          status.repository,
        ),
        syncError: repositoryState(s.syncError, spacePath, status.repository),
        branchError: repositoryState(
          s.branchError,
          spacePath,
          status.repository,
        ),
        remoteError: repositoryState(
          s.remoteError,
          spacePath,
          status.repository,
        ),
        remoteChecked: repositoryState(
          s.remoteChecked,
          spacePath,
          status.repository,
        ),
        remoteStatuses: repositoryState(
          s.remoteStatuses,
          spacePath,
          status.repository,
        ),
      }));
    },

    refreshStatus: async (spacePath, loadStatus) => {
      const version = (refreshVersions[spacePath] ?? 0) + 1;
      refreshVersions[spacePath] = version;
      try {
        const status = await loadStatus();
        if (refreshVersions[spacePath] !== version) return;
        get().applyStatus(spacePath, status);
      } catch (err) {
        if (refreshVersions[spacePath] === version) {
          set((s) => ({
            statusErrors: { ...s.statusErrors, [spacePath]: true },
          }));
        }
        // Space may not have git initialized yet — leave previous status alone
        console.debug("git_status failed for", spacePath, err);
      }
    },

    clear: (spacePath) =>
      set((s) => {
        refreshVersions[spacePath] = (refreshVersions[spacePath] ?? 0) + 1;
        remoteVersions[spacePath] = ++remoteVersion;
        publicationVersions[spacePath] = ++publicationVersion;
        delete syncRequests[spacePath];
        delete backendRequests[spacePath];
        const { [spacePath]: _rmBackendSync, ...backendSyncing } =
          s.backendSyncing;
        const { [spacePath]: _rmPublication, ...publications } = s.publications;
        const { [spacePath]: _rmStatus, ...statuses } = s.statuses;
        const { [spacePath]: _rmStatusError, ...statusErrors } = s.statusErrors;
        const { [spacePath]: _rmSync, ...syncing } = s.syncing;
        const { [spacePath]: _rmError, ...syncError } = s.syncError;
        const { [spacePath]: _rmRemoteError, ...remoteError } = s.remoteError;
        const { [spacePath]: _rmRemoteChecked, ...remoteChecked } =
          s.remoteChecked;
        const { [spacePath]: _rmRemoteStatus, ...remoteStatuses } =
          s.remoteStatuses;
        const { [spacePath]: _rmBranchError, ...branchError } = s.branchError;
        const { [spacePath]: _rmClone, ...cloning } = s.cloning;
        return {
          publications,
          statuses,
          statusErrors,
          syncing,
          backendSyncing,
          syncError,
          remoteError,
          remoteChecked,
          remoteStatuses,
          branchError,
          cloning,
        };
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
        const repository = s.statuses[spacePath]?.repository ?? spacePath;
        const next = { ...s.syncError };
        if (error) next[repository] = error;
        else delete next[repository];
        return { syncError: next };
      }),

    setBranchError: (spacePath, error) =>
      set((s) => {
        const repository = s.statuses[spacePath]?.repository ?? spacePath;
        const next = { ...s.branchError };
        if (error) next[repository] = error;
        else delete next[repository];
        return { branchError: next };
      }),

    setRemoteError: (spacePath, error) =>
      set((s) => {
        const repository = s.statuses[spacePath]?.repository ?? spacePath;
        const next = { ...s.remoteError };
        if (error) next[repository] = error;
        else delete next[repository];
        return {
          remoteError: next,
          ...(error
            ? { remoteChecked: { ...s.remoteChecked, [repository]: false } }
            : {}),
        };
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

/** Migrate provisional display-path state after the backend resolves identity. */
function repositoryState<T>(
  state: Record<string, T>,
  path: string,
  repository?: string,
) {
  if (!repository || repository === path || !(path in state)) return state;
  const next = { ...state };
  if (!(repository in next)) next[repository] = state[path];
  delete next[path];
  return next;
}

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
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface GitTreeNodeIndicatorTarget {
  path: string;
  isContainer?: boolean;
  pendingWrite?: boolean;
}

type DirtyFileChangeIndicator = Extract<FileChangeIndicator, { kind: "dirty" }>;
type DirtyFileChangeReason = DirtyFileChangeIndicator["reason"];
type DirtyFileChangeScope = DirtyFileChangeIndicator["scope"];

const CLEAN_FILE_INDICATOR: FileChangeIndicator = { kind: "clean" };
const CONFLICT_FILE_INDICATOR: FileChangeIndicator = { kind: "conflict" };
const DIRTY_FILE_INDICATORS = new Map<string, DirtyFileChangeIndicator>();

export function selectIndicator(
  state: GitState,
  spacePath: string,
): GitIndicator {
  const repository = state.statuses[spacePath]?.repository ?? spacePath;
  const cloning = state.cloning[spacePath];
  // A failed clone leaves `cloning.error` populated until the user dismisses
  // it — show `error` (✕) rather than keeping the spinner.
  if (cloning) return cloning.error ? "error" : "cloning";
  if (
    state.branchError[spacePath] ||
    state.syncError[spacePath] ||
    state.remoteError[spacePath] ||
    state.branchError[repository] ||
    state.syncError[repository] ||
    state.remoteError[repository]
  )
    return "error";
  const status = state.statuses[spacePath];
  if (status?.hasConflicts) return "conflict";
  if (state.syncing[spacePath] || state.backendSyncing[repository])
    return "syncing";
  if (status && (status.hasStaged || status.hasUnstaged)) return "dirty";
  return "clean";
}

export function selectFileIndicator(
  state: GitState,
  spacePath: string,
  filePath: string,
): "clean" | "dirty" | "conflict" {
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

  return selectFileTargetChangeIndicator(state, spacePath, {
    selfPaths: [nodePath],
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
    descendantPath: "",
  });
}

interface FileTargetChangeInput {
  selfPaths: string[];
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
  const descendantPath =
    target.descendantPath == null
      ? null
      : normalizeGitStatusPath(target.descendantPath);

  const selfFiles: FileGitStatus[] = [];
  const descendantFiles: FileGitStatus[] = [];

  for (const file of status?.files ?? []) {
    const filePath = normalizeGitStatusPath(file.path);
    if (selfPaths.has(filePath)) {
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

export function selectPublication(state: GitState, path: string) {
  return state.publications[state.statuses[path]?.repository ?? path];
}
