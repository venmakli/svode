export type {
  AssetsS3Config,
  AssetsSpaceConfig,
  AssetsStrategy,
  BinaryRoutingConfig,
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
  WindowOpenIntent,
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
/** The registered Spaces of a project, read from its config without opening it. */
export { listChildSpaces as readProjectSpaces } from "./api/space-store-actions";
export { CreateSpaceDialog } from "./ui/create-space-dialog";
