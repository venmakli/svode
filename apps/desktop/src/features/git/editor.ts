import { useGitStore, type GitStatus } from "./model";

export {
  commitAllSpace,
  commitFileAndMaybeSync,
  syncSpace,
} from "./api/git-actions";

export function getGitSpaceStatus(spacePath: string): GitStatus | undefined {
  return useGitStore.getState().statuses[spacePath];
}

export function refreshGitSpaceStatus(spacePath: string): Promise<void> {
  return useGitStore.getState().refreshStatus(spacePath);
}
