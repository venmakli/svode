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
  TreeNode,
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
export { CreateSpaceDialog } from "./ui/create-space-dialog";
