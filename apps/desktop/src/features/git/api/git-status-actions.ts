import { getGitStatus as getPlatformGitStatus } from "@/platform/git/git-api";
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
