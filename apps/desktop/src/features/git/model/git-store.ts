import { create } from "zustand";
import type {
  FileGitState,
  GitCloneProgress,
  GitStatus,
  GitStatusFailure,
  GitPublicationStatus,
  GitSyncMerged,
} from "./types";
import type { GitSyncStop } from "./sync-stop";
import type { GitPublicationBlock } from "./publication-block";
import {
  containerPathForNodePath,
  isGitStatusPathDescendant,
  normalizeGitStatusPath,
} from "./git-paths";
import { gitStatusPathIndex } from "./git-status-index";

/**
 * Per-space git state.
 *
 * Sources of truth:
 * - `statuses` is the latest `git status` snapshot per space path.
 * - `statusErrors` is why the latest status read failed, until one succeeds.
 * - `syncing` flags spaces in the middle of an explicit sync; a background
 *   sync shows only its result (Stage 11 1.E).
 * - `lastSynced` is when each repository last synced on this device.
 * - `cloning` tracks in-progress `git clone` operations and their percent.
 * - `syncError` is set when sync fails (auth/network) → indicator goes to `✕`.
 * - `syncStop` is the unfinished Git operation that stops sync.
 * - `syncMerged` are the Svode service files the last sync merged and the
 *   items it renumbered.
 * - `publicationBlock` lists the Spaces that stopped the project publication;
 *   like a stop, it is not a sync error.
 */
interface GitState {
  publications: Record<string, GitPublicationStatus>;
  beginPublicationRead: (path: string) => () => boolean;
  setPublication: (
    path: string,
    publication: GitPublicationStatus | null,
  ) => void;
  statuses: Record<string, GitStatus>;
  statusErrors: Record<string, GitStatusFailure>;
  syncing: Record<string, boolean>;
  backendSyncing: Record<string, boolean>;
  updateBackendSyncing: (path: string, active: boolean) => void;
  /** Repository → milliseconds since the Unix epoch of its last sync. */
  lastSynced: Record<string, number>;
  setLastSynced: (path: string, at: number | null) => void;
  syncError: Record<string, string>;
  syncStop: Record<string, GitSyncStop>;
  syncMerged: Record<string, GitSyncMerged>;
  publicationBlock: Record<string, GitPublicationBlock>;
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
  /** Start a sync of `path`; only an explicit one (`indicate`) shows it runs. */
  beginSync: (
    path: string,
    indicate?: boolean,
  ) => { current: () => boolean; finish: () => void };
  branchError: Record<string, string>;
  cloning: Record<string, GitCloneProgress>;

  /** Apply a status returned by a git IPC command. */
  applyStatus: (spacePath: string, status: GitStatus) => void;
  /** Fetch fresh status through the feature API while guarding stale responses. */
  refreshStatus: (
    spacePath: string,
    loadStatus: () => Promise<GitStatus>,
    failure: (error: unknown) => GitStatusFailure,
  ) => Promise<void>;
  /** Clear local state for a removed space. */
  clear: (spacePath: string) => void;

  setSyncing: (spacePath: string, syncing: boolean) => void;
  setSyncError: (spacePath: string, error: string | null) => void;
  setSyncStop: (spacePath: string, stop: GitSyncStop | null) => void;
  setSyncMerged: (spacePath: string, merged: GitSyncMerged) => void;
  setPublicationBlock: (
    spacePath: string,
    block: GitPublicationBlock | null,
  ) => void;
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
  const syncRequests: Record<
    string,
    { count: number; indicated: number; version: number }
  > = {};

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
    lastSynced: {},
    setLastSynced: (path, at) =>
      set((s) => {
        const repository = s.statuses[path]?.repository ?? path;
        if (at == null)
          return { lastSynced: withoutPath(s.lastSynced, repository) };
        if (s.lastSynced[repository] === at) return s;
        return { lastSynced: { ...s.lastSynced, [repository]: at } };
      }),
    syncError: {},
    syncStop: {},
    syncMerged: {},
    publicationBlock: {},
    remoteError: {},
    remoteChecked: {},
    remoteStatuses: {},
    branchError: {},
    cloning: {},

    beginSync: (path, indicate = true) => {
      const pending = (syncRequests[path] ??= {
        count: 0,
        indicated: 0,
        version: 0,
      });
      pending.count++;
      if (indicate) pending.indicated++;
      const version = ++pending.version;
      if (indicate) get().setSyncing(path, true);
      get().setSyncError(path, null);
      get().setPublicationBlock(path, null);
      get().setBranchError(path, null);
      return {
        current: () =>
          syncRequests[path] === pending && pending.version === version,
        finish: () => {
          if (syncRequests[path] !== pending) return;
          if (indicate && --pending.indicated === 0)
            get().setSyncing(path, false);
          if (--pending.count === 0) delete syncRequests[path];
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
        statusErrors: withoutPath(s.statusErrors, spacePath),
        publications: repositoryState(
          s.publications,
          spacePath,
          status.repository,
        ),
        syncError: repositoryState(s.syncError, spacePath, status.repository),
        syncStop: repositoryState(s.syncStop, spacePath, status.repository),
        syncMerged: repositoryState(s.syncMerged, spacePath, status.repository),
        publicationBlock: repositoryState(
          s.publicationBlock,
          spacePath,
          status.repository,
        ),
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
        lastSynced: repositoryState(s.lastSynced, spacePath, status.repository),
      }));
    },

    refreshStatus: async (spacePath, loadStatus, failure) => {
      const version = (refreshVersions[spacePath] ?? 0) + 1;
      refreshVersions[spacePath] = version;
      try {
        const status = await loadStatus();
        if (refreshVersions[spacePath] !== version) return;
        get().applyStatus(spacePath, status);
      } catch (err) {
        if (refreshVersions[spacePath] === version) {
          set((s) => ({
            statusErrors: { ...s.statusErrors, [spacePath]: failure(err) },
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
        const { [spacePath]: _rmStop, ...syncStop } = s.syncStop;
        const { [spacePath]: _rmMerged, ...syncMerged } = s.syncMerged;
        const { [spacePath]: _rmBlock, ...publicationBlock } =
          s.publicationBlock;
        const { [spacePath]: _rmRemoteError, ...remoteError } = s.remoteError;
        const { [spacePath]: _rmRemoteChecked, ...remoteChecked } =
          s.remoteChecked;
        const { [spacePath]: _rmRemoteStatus, ...remoteStatuses } =
          s.remoteStatuses;
        const { [spacePath]: _rmBranchError, ...branchError } = s.branchError;
        const { [spacePath]: _rmClone, ...cloning } = s.cloning;
        const { [spacePath]: _rmLastSynced, ...lastSynced } = s.lastSynced;
        return {
          lastSynced,
          publications,
          statuses,
          statusErrors,
          syncing,
          backendSyncing,
          syncError,
          syncStop,
          syncMerged,
          publicationBlock,
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

    setSyncStop: (spacePath, stop) =>
      set((s) => {
        const repository = s.statuses[spacePath]?.repository ?? spacePath;
        const next = { ...s.syncStop };
        if (stop) next[repository] = stop;
        else delete next[repository];
        return { syncStop: next };
      }),

    setSyncMerged: (spacePath, merged) =>
      set((s) => {
        const repository = s.statuses[spacePath]?.repository ?? spacePath;
        const named = merged.files.length > 0 || merged.renumbered.length > 0;
        if (!named && !s.syncMerged[repository]) return s;
        const next = { ...s.syncMerged };
        if (named) next[repository] = merged;
        else delete next[repository];
        return { syncMerged: next };
      }),

    setPublicationBlock: (spacePath, block) =>
      set((s) => {
        const repository = s.statuses[spacePath]?.repository ?? spacePath;
        const next = { ...s.publicationBlock };
        if (block) next[repository] = block;
        else delete next[repository];
        return { publicationBlock: next };
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

function withoutPath<T>(state: Record<string, T>, path: string) {
  if (!(path in state)) return state;
  const { [path]: _removed, ...rest } = state;
  return rest;
}

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
    selfPath: filePath,
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
    selfPath: nodePath,
    descendantPath: containerPath,
    pendingWrite: target.pendingWrite,
  });
}

export function selectSpaceRootChangeIndicator(
  state: GitState,
  spacePath: string,
): FileChangeIndicator {
  return selectFileTargetChangeIndicator(state, spacePath, {
    selfPath: "README.md",
    descendantPath: "",
  });
}

interface FileTargetChangeInput {
  selfPath: string;
  descendantPath?: string | null;
  pendingWrite?: boolean;
}

function selectFileTargetChangeIndicator(
  state: GitState,
  spacePath: string,
  target: FileTargetChangeInput,
): FileChangeIndicator {
  const status = state.statuses[spacePath];
  const index = status ? gitStatusPathIndex(status) : undefined;
  const selfPath = normalizeGitStatusPath(target.selfPath);
  const descendantPath =
    target.descendantPath == null
      ? null
      : normalizeGitStatusPath(target.descendantPath);

  const self = index?.paths.get(selfPath);
  const folder =
    descendantPath === null ? undefined : index?.folders.get(descendantPath);
  // Files at the target's own path never count as its descendants.
  const selfInFolder =
    self &&
    descendantPath !== null &&
    isGitStatusPathDescendant(selfPath, descendantPath)
      ? self
      : undefined;
  const selfCount = self?.files.length ?? 0;
  const descendantCount =
    (folder?.count ?? 0) - (selfInFolder?.files.length ?? 0);

  if (
    (self?.conflicts ?? 0) > 0 ||
    (folder?.conflicts ?? 0) > (selfInFolder?.conflicts ?? 0)
  ) {
    return CONFLICT_FILE_INDICATOR;
  }

  const hasSelfChanges = selfCount > 0 || target.pendingWrite === true;
  const hasDescendantChanges = descendantCount > 0;
  if (hasSelfChanges || hasDescendantChanges) {
    const scope =
      hasSelfChanges && hasDescendantChanges
        ? "mixed"
        : hasSelfChanges
          ? "self"
          : "descendants";
    const firstFile =
      self?.files[0] ?? (hasDescendantChanges ? folder?.first : undefined);
    return dirtyFileChangeIndicator(
      target.pendingWrite && selfCount === 0 ? "pending_write" : "git_dirty",
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
