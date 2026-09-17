import {
  recordSavedPublication,
  recordSyncPublication,
} from "./git-publication-actions";
import { gitBranchErrorMessage } from "./git-branch-error";
import { gitSyncErrorMessage } from "./git-sync-error";
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
import { refreshGitRemoteStatus, refreshGitStatus } from "./git-status-actions";

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
export async function syncSpace(
  spacePath: string,
  background = false,
): Promise<GitSyncOutcome> {
  return runSync(spacePath, () => syncGit(spacePath, background));
}

async function runSync(
  spacePath: string,
  execute: () => ReturnType<typeof syncGit>,
): Promise<GitSyncOutcome> {
  const git = useGitStore.getState();
  const request = git.beginSync(spacePath);
  try {
    const dto = await execute();
    const result = toSyncResult(dto);
    if (!request.current()) return result;
    if (dto.type === "success" && dto.remoteStatus) {
      git.applyRemoteStatus(spacePath, toGitStatus(dto.remoteStatus));
    }
    recordSyncPublication(spacePath, result);
    switch (result.type) {
      case "Success":
        if (dto.type === "success" && !dto.remoteStatus) {
          void refreshGitRemoteStatus(spacePath).catch(() => {});
        }
        if (dto.type === "success" && !dto.remoteStatus) {
          await refreshGitStatus(spacePath).catch(() => {});
        }
        return result;
      case "NoRemote":
        // Silent — no remote configured is a normal state.
        return result;
      case "Conflict":
        await refreshGitStatus(spacePath);
        if (request.current()) git.setSyncError(spacePath, "conflict");
        return result;
      case "AuthRequired":
        git.setSyncError(spacePath, "auth");
        return result;
    }
  } catch (err) {
    console.error("git_sync failed:", err);
    const branchMessage = gitBranchErrorMessage(err);
    if (!request.current())
      return { type: "Failed", message: gitSyncErrorMessage(err) };
    if (branchMessage) git.setBranchError(spacePath, branchMessage);
    const message = gitSyncErrorMessage(err);
    git.setSyncError(spacePath, branchMessage ? null : message);
    return { type: "Failed", message };
  } finally {
    request.finish();
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
    void syncSpace(spacePath, true);
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
    void syncSpace(spacePath, true);
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
    void syncSpace(spacePath, true);
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
  const outcome = await runSync(spacePath, () =>
    continuePlatformGitResolve(spacePath),
  );
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
