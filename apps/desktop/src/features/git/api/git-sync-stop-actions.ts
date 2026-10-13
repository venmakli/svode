import { abortGitMerge, getGitSyncPreflight } from "@/platform/git/git-api";
import { syncStopFromResult, useGitStore, type SyncResult } from "../model";
import { toGitStatus, toSyncResult } from "./git-mappers";
import { refreshGitRemoteStatus } from "./git-status-actions";

/** Keep the repository's sync stop in step with what a sync reported. */
export function recordSyncStop(path: string, result: SyncResult) {
  const stop = syncStopFromResult(result);
  if (stop !== undefined) useGitStore.getState().setSyncStop(path, stop);
}

/** Read the unfinished Git operation of the repository without syncing. */
export async function refreshGitSyncStop(path: string): Promise<void> {
  const dto = await getGitSyncPreflight(path);
  useGitStore
    .getState()
    .setSyncStop(
      path,
      dto ? (syncStopFromResult(toSyncResult(dto)) ?? null) : null,
    );
}

/**
 * Cancel the sync stopped by a merge conflict: the repository returns to its
 * state before the merge, and the incoming changes show as incoming again.
 */
export async function abortGitSyncMerge(path: string): Promise<void> {
  const status = toGitStatus(await abortGitMerge(path));
  const git = useGitStore.getState();
  git.applyStatus(path, status);
  git.setSyncStop(path, null);
  await refreshGitRemoteStatus(path).catch(() => {});
}
