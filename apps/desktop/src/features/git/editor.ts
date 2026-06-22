import { useGitStore, type GitStatus } from "./model";
import { refreshGitStatus } from "./api/git-status-actions";

export {
  commitAllSpace,
  commitFileAndMaybeSync,
  continueGitResolve,
  syncSpace,
} from "./api/git-actions";
export type { GitCommitResult } from "./api/git-actions";

export function getGitSpaceStatus(spacePath: string): GitStatus | undefined {
  return useGitStore.getState().statuses[spacePath];
}

export function refreshGitSpaceStatus(spacePath: string): Promise<void> {
  return refreshGitStatus(spacePath);
}
