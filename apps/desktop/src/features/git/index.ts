export type {
  CloneProgress,
  FileGitState,
  FileGitStatus,
  GitAvailability,
  GitCloneProgress,
  GitStatus,
  SyncResult,
} from "./model/types";
export {
  commitAllSpace,
  commitFileAndMaybeSync,
  syncOnOpen,
  syncSpace,
} from "./api/git-actions";
export type { GitCommitResult } from "./api/git-actions";
export { setSpaceCloneProgress } from "./api/git-clone-progress-actions";
export { useGitAvailability } from "./hooks/use-git-availability";
export { GitIndicatorIcon } from "./ui/git-status-indicator";
export { GitMissingDialog } from "./ui/git-missing-dialog";
export { SpaceGitWatcher } from "./ui/space-git-watcher";
