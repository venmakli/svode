import { getGitSyncPreflight } from "@/platform/git/git-api";
import { syncStopFromResult, useGitStore, type SyncResult } from "../model";
import { toSyncResult } from "./git-mappers";

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
