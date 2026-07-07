export type {
  CloneProgress,
  FileGitState,
  FileGitStatus,
  GitAvailability,
  GitCloneProgress,
  GitAuthChallenge,
  GitStatus,
  GitRemoteAuthMethod,
  GitRemoteAuthCredentials,
  GitRemoteOperation,
  GitUserPolicy,
  GitUnpushedCommit,
  SyncResult,
} from "./model/types";
export { getGitAvailability } from "./api/git-availability-actions";
export { trackSpaceCloneProgress } from "./api/git-clone-progress-actions";
export { getGitStatusSnapshot } from "./api/git-status-actions";
export { saveGitRemoteCredentials } from "./api/git-actions";
export {
  gitAuthChallengeFromRemoteUrl,
  isGitAuthRequiredError,
} from "./model/remote-auth";
export { GitRemoteAuthDialog } from "./ui/git-remote-auth-dialog";
