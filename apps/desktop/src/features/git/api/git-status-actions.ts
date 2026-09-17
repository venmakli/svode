import {
  fetchGitStatus as fetchPlatformGitStatus,
  getGitStatus as getPlatformGitStatus,
} from "@/platform/git/git-api";
import { useGitStore, type GitStatus } from "../model";
import { toGitStatus } from "./git-mappers";
import { gitSyncErrorMessage } from "./git-sync-error";

export async function getGitStatusSnapshot(
  spacePath: string,
): Promise<GitStatus> {
  return toGitStatus(await getPlatformGitStatus(spacePath));
}

export function refreshGitStatus(spacePath: string): Promise<void> {
  return useGitStore
    .getState()
    .refreshStatus(spacePath, () => getGitStatusSnapshot(spacePath));
}

export async function fetchGitStatusSnapshot(
  spacePath: string,
): Promise<GitStatus> {
  return toGitStatus(await fetchPlatformGitStatus(spacePath));
}

export function refreshGitRemoteStatus(spacePath: string): Promise<GitStatus> {
  return useGitStore.getState().refreshRemoteStatus(
    spacePath,
    () => fetchGitStatusSnapshot(spacePath),
    gitSyncErrorMessage,
    async () => toGitStatus(await getPlatformGitStatus(spacePath, true)),
  );
}
