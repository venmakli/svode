export { gitSaveShortcuts } from "./model/shortcut-descriptions";
export { useAppGitFocus } from "./hooks/use-app-git-focus";
export {
  closeAllVersionGroups,
  closeLeftVersionGroup,
} from "./api/git-auto-version-actions";
export { GitSyncStatusWidget } from "./ui/git-sync-status-widget";
export { GitGate } from "./ui/git-gate";
export { SpaceGitWatcher } from "./ui/space-git-watcher";
export {
  commitSaveScopeAndMaybeSync,
  dirtyPathsForGitSaveScope,
  explicitCommitRefusal,
  getGitSpaceStatus,
  gitSaveShortcutLabel,
  notifyGitCommitRefusal,
  refreshGitSpaceStatus,
  resolveGitSaveAllScope,
  type GitSaveScope,
  type GitSaveScopeLabel,
  type GitSaveScopeTreeNode,
} from "./editor";
export { registerRepositorySettingsOpener } from "./model/repository-owner";
export {
  conflictFileOpener,
  registerConflictNavigation,
  type ConflictFileTarget,
} from "./model/conflict-navigation";
export { useGitPathInConflict } from "./hooks/use-git-path-in-conflict";
export { registerAgentRequests } from "./model/agent-request";
