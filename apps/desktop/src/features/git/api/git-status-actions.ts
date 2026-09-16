import {
  fetchGitStatus as fetchPlatformGitStatus,
  getGitStatus as getPlatformGitStatus,
} from "@/platform/git/git-api";
import { useGitStore, type GitStatus } from "../model";
import { toGitStatus } from "./git-mappers";
import { gitSyncErrorMessage } from "./git-sync-error";

const remoteRefreshes = new Map<string, Promise<GitStatus>>();

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
  const active = remoteRefreshes.get(spacePath);
  if (active) return active;
  const refresh = fetchRemoteStatus(spacePath).finally(() => {
    remoteRefreshes.delete(spacePath);
  });
  remoteRefreshes.set(spacePath, refresh);
  return refresh;
}

async function fetchRemoteStatus(spacePath: string): Promise<GitStatus> {
  const git = useGitStore.getState();
  try {
    const status = await fetchGitStatusSnapshot(spacePath);
    git.applyStatus(spacePath, status);
    git.setRemoteError(spacePath, null);
    return status;
  } catch (err) {
    git.setRemoteError(spacePath, gitSyncErrorMessage(err));
    throw err;
  }
}
