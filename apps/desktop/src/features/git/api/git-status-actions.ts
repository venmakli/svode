import {
  fetchGitStatus as fetchPlatformGitStatus,
  getGitStatus as getPlatformGitStatus,
} from "@/platform/git/git-api";
import { useGitStore, type GitStatus } from "../model";
import { toGitStatus } from "./git-mappers";

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

export async function refreshGitRemoteStatus(
  spacePath: string,
): Promise<GitStatus> {
  const git = useGitStore.getState();
  try {
    const status = await fetchGitStatusSnapshot(spacePath);
    git.applyStatus(spacePath, status);
    git.setSyncError(spacePath, null);
    return status;
  } catch (err) {
    git.setSyncError(spacePath, String(err));
    throw err;
  }
}
