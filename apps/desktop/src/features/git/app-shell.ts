export { useAppGitFocus } from "./hooks/use-app-git-focus";
export { useGitAvailability } from "./hooks/use-git-availability";
export { GitSyncStatusWidget } from "./ui/git-sync-status-widget";
export { GitMissingDialog } from "./ui/git-missing-dialog";
export { SpaceGitWatcher } from "./ui/space-git-watcher";
export {
  commitSaveScopeAndMaybeSync,
  dirtyPathsForGitSaveScope,
  getGitSpaceStatus,
  gitSaveShortcutLabel,
  type GitSaveScope,
  type GitSaveScopeLabel,
} from "./editor";
