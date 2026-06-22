import { getGitStatus } from "@/platform/git/git-api";
import { useGitStore } from "../model";

export function refreshGitStatus(spacePath: string): Promise<void> {
  return useGitStore
    .getState()
    .refreshStatus(spacePath, () => getGitStatus(spacePath));
}
