export { avatarColorFromEmail, AVATAR_COLORS } from "./lib";
export { IdentityDialog } from "./ui/identity-dialog";
export type {
  FanoutPreviewEntry,
  GitIdentity,
  GitIdentityFieldSource,
  GlobalIdentityMutationResult,
  GlobalIdentityMutationStatus,
  GlobalIdentityResult,
  IdentityFieldSources,
  RepoIdentityResult,
  RepoIdentitySource,
} from "./model";
export {
  getGlobalIdentity,
  getProjectFanoutPreview,
  getRepoIdentity,
  listenGlobalIdentityChanged,
  saveGlobalIdentity,
  saveProjectIdentity,
  saveRepoIdentity,
  type SaveProjectIdentityInput,
  type SaveRepoIdentityInput,
} from "./api";
export {
  useGlobalIdentity,
  useGlobalIdentityFingerprint,
  useIdentityCheck,
  useIdentityGateState,
  useIdentityRefreshNotifier,
  useSaveGlobalIdentity,
} from "./hooks";
export { isValidEmail, isValidName } from "./lib";
