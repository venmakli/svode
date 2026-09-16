import {
  recordSavedPublication,
  recordSyncPublication,
} from "./git-publication-actions";
import { gitBranchErrorMessage } from "./git-branch-error";
import { gitSyncErrorMessage } from "./git-sync-error";
import { isGitStatusPathDescendant } from "../model/git-paths";
import { useGitStore } from "../model";
import {
  commitGitAll,
  commitGitFile,
  commitGitPaths,
  continueGitResolve as continuePlatformGitResolve,
  getGitUserPolicy,
  saveGitHttpCredentials,
  syncGit,
} from "@/platform/git/git-api";
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

function retainBranchError(error: unknown, spacePath: string) {
  const message = gitBranchErrorMessage(error);
  if (message) useGitStore.getState().setBranchError(spacePath, message);
}

export interface GitAutoSyncOptions {
  onSyncOutcome?: (outcome: GitSyncOutcome) => void;
}

export interface SaveGitRemoteCredentialsInput {
  remoteUrl: string;
  username: string;
  password: string;
}

export function saveGitRemoteCredentials({
  remoteUrl,
  username,
  password,
}: SaveGitRemoteCredentialsInput): Promise<void> {
  return saveGitHttpCredentials({ remoteUrl, username, password });
}

function runAutoSync(spacePath: string): void {
  const active = syncs.get(spacePath);
  if (active) {
    // A save arriving during a sync must get its own subsequent publication.
    active.request.again = true;
    return;
  }
  void syncSpace(spacePath, true);
}

const syncs = new Map<
  string,
  {
    promise: Promise<GitSyncOutcome>;
    request: { background: boolean; again: boolean };
  }
>();

/**
 * Read the local per-user auto-sync policy (default: false).
 */
export async function isAutoSyncEnabled(
  spacePath: string,
  projectPath?: string | null,
): Promise<boolean> {
  try {
    const policy = await getGitUserPolicy({ spacePath, projectPath });
    return policy.autoSync === true;
  } catch {
    return false;
  }
}

/**
 * Run pull+push for the space and return a typed outcome to callers.
 * Updates per-space syncing/error state in the git store.
 */
export function syncSpace(
  spacePath: string,
  background = false,
): Promise<GitSyncOutcome> {
  const active = syncs.get(spacePath);
  if (active) {
    if (!background && active.request.background) {
      active.request.background = false;
      active.request.again = true;
    }
    return active.promise;
  }
  const request = { background, again: false };
  useGitStore.getState().setSyncing(spacePath, true);
  const promise = Promise.resolve()
    .then(async () => {
      let result: GitSyncOutcome;
      do {
        request.again = false;
        result = await runSync(spacePath, request.background);
      } while (request.again);
      return result;
    })
    .finally(() => {
      syncs.delete(spacePath);
      useGitStore.getState().setSyncing(spacePath, false);
    });
  syncs.set(spacePath, { request, promise });
  return promise;
}

async function runSync(
  spacePath: string,
  background: boolean,
): Promise<GitSyncOutcome> {
  const git = useGitStore.getState();
  git.setSyncError(spacePath, null);
  git.setBranchError(spacePath, null);
  try {
    const result = toSyncResult(await syncGit(spacePath, background));
    recordSyncPublication(spacePath, result);
    switch (result.type) {
      case "Success":
        git.setRemoteError(spacePath, null);
        // Refresh status to clear any local indicators (file `↻`).
        await refreshGitStatus(spacePath).catch(() => {});
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
    const branchMessage = gitBranchErrorMessage(err);
    if (branchMessage) git.setBranchError(spacePath, branchMessage);
    const message = gitSyncErrorMessage(err);
    git.setSyncError(spacePath, branchMessage ? null : message);
    return { type: "Failed", message };
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
    const saved = await commitGitFile({
      projectPath,
      spacePath,
      filePath,
    });
    recordSavedPublication(spacePath, saved);
    const status = toGitStatus(saved);
    useGitStore.getState().applyStatus(spacePath, status);
    result = {
      status,
      committedPaths: status.files.some((file) => file.path === filePath)
        ? []
        : [filePath],
    };
  } catch (err) {
    console.error("git_commit_file failed:", err);
    retainBranchError(err, spacePath);
    await refreshGitStatus(spacePath);
    throw err;
  }
  useGitStore.getState().setBranchError(spacePath, null);
  if (await isAutoSyncEnabled(spacePath, projectPath)) {
    runAutoSync(spacePath);
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
    useGitStore
      .getState()
      .statuses[spacePath]?.files.map((file) => file.path) ?? [];
  let result: GitCommitResult;
  try {
    const saved = await commitGitAll({
      projectPath,
      spacePath,
    });
    recordSavedPublication(spacePath, saved);
    const status = toGitStatus(saved);
    useGitStore.getState().applyStatus(spacePath, status);
    const stillDirty = new Set(
      status.files.map((file) => normalizeGitStatusPath(file.path)),
    );
    result = {
      status,
      committedPaths: previousDirtyPaths.filter(
        (path) => !stillDirty.has(path),
      ),
    };
  } catch (err) {
    console.error("git_commit_all failed:", err);
    retainBranchError(err, spacePath);
    await refreshGitStatus(spacePath);
    throw err;
  }
  useGitStore.getState().setBranchError(spacePath, null);
  if (await isAutoSyncEnabled(spacePath, projectPath)) {
    runAutoSync(spacePath);
  }
  return result;
}

export async function commitPathsAndMaybeSync(
  spacePath: string,
  filePaths: string[],
  projectPath?: string,
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
    const saved = await commitGitPaths({
      projectPath,
      spacePath,
      filePaths: targetPaths,
    });
    recordSavedPublication(spacePath, saved);
    const status = toGitStatus(saved);
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
    retainBranchError(err, spacePath);
    await refreshGitStatus(spacePath);
    throw err;
  }
  useGitStore.getState().setBranchError(spacePath, null);
  if (await isAutoSyncEnabled(spacePath, projectPath)) {
    runAutoSync(spacePath);
  }
  return result;
}

export async function commitSaveScopeAndMaybeSync(
  spacePath: string,
  scope: GitSaveScope,
  extraPaths: string[],
  projectPath?: string,
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
  return commitPathsAndMaybeSync(spacePath, filePaths, projectPath);
}

export async function continueGitResolve(
  spacePath: string,
  options?: GitAutoSyncOptions,
): Promise<void> {
  const outcome = toSyncResult(await continuePlatformGitResolve(spacePath));
  recordSyncPublication(spacePath, outcome);
  await refreshGitStatus(spacePath);
  options?.onSyncOutcome?.(outcome);
}

/**
 * Sync on space open. Silent on failure (no remote / offline / auth).
 */
export async function syncOnOpen(
  spacePath: string,
  projectPath?: string | null,
): Promise<void> {
  if (!(await isAutoSyncEnabled(spacePath, projectPath))) return;
  if (spacePath === projectPath) {
    // A child save already owns its parent publication step. Opening that
    // project waits for this result before attempting another root sync.
    const children = [...syncs.entries()]
      .filter(([path]) => isGitStatusPathDescendant(path, spacePath))
      .map(([, flight]) => flight.promise);
    if (children.length > 0) await Promise.all(children);
  }
  await syncSpace(spacePath, true);
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
