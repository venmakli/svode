export { avatarColorFromEmail, AVATAR_COLORS } from "./lib";
export { IdentityDialog } from "./ui/identity-dialog";
export type {
  FanoutPreviewEntry,
  GitIdentity,
  GitIdentityFieldSource,
  GlobalIdentityResult,
  IdentityFieldSources,
  RepoIdentityResult,
  RepoIdentitySource,
} from "./model";
export {
  getGlobalIdentity,
  getProjectFanoutPreview,
  getRepoIdentity,
  saveGlobalIdentity,
  saveProjectIdentity,
  saveRepoIdentity,
  type SaveProjectIdentityInput,
  type SaveRepoIdentityInput,
} from "./api";
export {
  useGlobalIdentity,
  useIdentityCheck,
  useIdentityGateState,
  useIdentityRefreshNotifier,
  useSaveGlobalIdentity,
} from "./hooks";
export { isValidEmail, isValidName } from "./lib";
