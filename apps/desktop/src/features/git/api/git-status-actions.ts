import { coalesceByKey } from "@/shared/lib/coalesce-by-key";
import {
  fetchGitStatus as fetchPlatformGitStatus,
  getGitStatus as getPlatformGitStatus,
} from "@/platform/git/git-api";
import { useGitStore, type GitStatus } from "../model";
import { toGitStatus } from "./git-mappers";
import { gitStatusFailureFromError } from "./git-status-error";
import { gitSyncErrorMessage } from "./git-sync-error";

export async function getGitStatusSnapshot(
  spacePath: string,
): Promise<GitStatus> {
  return toGitStatus(await getPlatformGitStatus(spacePath));
}

/**
 * Read the status of the Space into the store: one read per Space at a time,
 * and the calls during it share one read after it.
 */
export const refreshGitStatus = coalesceByKey((spacePath: string) =>
  useGitStore
    .getState()
    .refreshStatus(
      spacePath,
      () => getGitStatusSnapshot(spacePath),
      gitStatusFailureFromError,
    ),
);

export async function fetchGitStatusSnapshot(
  spacePath: string,
): Promise<GitStatus> {
  return toGitStatus(await fetchPlatformGitStatus(spacePath));
}

/**
 * Read the remote counters of the Space into the store: one read per Space
 * at a time, and the calls during it share one read after it.
 */
export const refreshGitRemoteStatus = coalesceByKey(
  (spacePath: string): Promise<GitStatus> =>
    useGitStore.getState().refreshRemoteStatus(
      spacePath,
      () => fetchGitStatusSnapshot(spacePath),
      gitSyncErrorMessage,
      async () => toGitStatus(await getPlatformGitStatus(spacePath, true)),
    ),
);
