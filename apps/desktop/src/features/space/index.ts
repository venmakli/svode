export type {
  AgentConfig,
  AssetsS3Config,
  AssetsSpaceConfig,
  AssetsStrategy,
  GitSpaceConfig,
  LfsState,
  LocalConfig,
  SpaceConfig,
  SpaceDefaults,
  SpaceGitType,
  SpaceInfo,
  SpaceRef,
  SpaceStatus,
} from "./model/types";
export {
  getSpaceSnapshot,
  getSpaceTreeSyncSnapshot,
  registerRootSpace,
  selectActiveSpaceId,
  selectActiveSpacePath,
  useSpace,
  useSpaceTreeSync,
  type SpacePublicState,
  type SpaceTreeSyncState,
} from "./model/public-space";
export { useSpaceActions } from "./hooks/use-space-actions";
export { SpaceSidebar } from "./ui/space-sidebar";
export { MainBreadcrumbs } from "./ui/main-breadcrumbs";
export { EmptyProjectState } from "./ui/empty-project-state";
export { SpaceFileWatcher } from "./ui/space-file-watcher";
