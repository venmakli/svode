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
export { useRepositoryAccess } from "./hooks/use-repository-access";
export type {
  RepositoryAccessReason,
  RepositoryAccessSnapshot,
  RepositoryAccessStatus,
} from "./model/repository-access";
export {
  gitAuthChallengeFromRemoteUrl,
  isGitAuthRequiredError,
} from "./model/remote-auth";
export { GitRemoteAuthDialog } from "./ui/git-remote-auth-dialog";
