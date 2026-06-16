export {
  avatarColorFromEmail,
  AVATAR_COLORS,
} from "./lib";
export { IdentityDialog } from "./ui/identity-dialog";
export { useIdentityStore } from "./model";
export type {
  FanoutPreviewEntry,
  GitIdentity,
  GlobalIdentityResult,
  RepoIdentityResult,
} from "./model";
export { useEffectiveIdentity, useIdentityCheck } from "./hooks";
export { isValidEmail, isValidName } from "./lib";
