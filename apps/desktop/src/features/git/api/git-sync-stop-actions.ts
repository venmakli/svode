import { abortGitMerge, getGitSyncPreflight } from "@/platform/git/git-api";
import {
  serviceMergedFromResult,
  syncStopFromResult,
  syncStopIsBackgroundPreflight,
  useGitStore,
  type GitSyncStop,
  type SyncResult,
} from "../model";
import { toGitStatus, toSyncResult } from "./git-mappers";
import { refreshGitRemoteStatus } from "./git-status-actions";

/**
 * Keep the repository's sync stop and the service files it names as merged
 * in step with what a sync reported. A refused automatic commit is not a
 * sync state: it lasts until the next automatic version.
 */
export function recordSyncStop(path: string, result: SyncResult) {
  const git = useGitStore.getState();
  const stop = syncStopFromResult(result);
  const keepCommitStop = stop === null && currentStop(path)?.kind === "commit";
  if (stop !== undefined && !keepCommitStop) git.setSyncStop(path, stop);
  const merged = serviceMergedFromResult(result);
  if (merged !== undefined) git.setServiceMerged(path, merged);
}

/**
 * Keep the publication stop in step with a failed sync: the guard's refusal
 * sets it, any other failure ends it and leaves other stops as they are.
 */
export function recordPublicationStop(path: string, stop: GitSyncStop | null) {
  if (stop || currentStop(path)?.kind === "publication")
    useGitStore.getState().setSyncStop(path, stop);
}

/**
 * Read the unfinished Git operation of the repository without syncing. A
 * publication stop and the stops of a background preflight are not states
 * of the repository: they last until the next sync; a commit stop lasts
 * until the next automatic version.
 */
export async function refreshGitSyncStop(path: string): Promise<void> {
  const dto = await getGitSyncPreflight(path);
  const preflight = dto
    ? (syncStopFromResult(toSyncResult(dto)) ?? null)
    : null;
  const current = currentStop(path);
  useGitStore
    .getState()
    .setSyncStop(
      path,
      preflight ??
        (current &&
        (current.kind === "publication" ||
          current.kind === "commit" ||
          syncStopIsBackgroundPreflight(current))
          ? current
          : null),
    );
}

function currentStop(path: string): GitSyncStop | undefined {
  const git = useGitStore.getState();
  return git.syncStop[git.statuses[path]?.repository ?? path];
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
