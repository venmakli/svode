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
export {
  useRepositoryAccessPreflight,
  type RepositoryAccessPreflightController,
} from "./hooks/use-repository-access-preflight";
export { repositoryAccessDenialFromError } from "./api/repository-access-api";
export type {
  RepositoryAccessDenial,
  RepositoryAccessPrimaryAction,
  RepositoryAccessReason,
  RepositoryAccessSnapshot,
  RepositoryAccessStatus,
} from "./model/repository-access";
export type { RepositoryAccessView } from "./model/repository-access-owner";
export type {
  RepositoryAccessContinuationPolicy,
  RepositoryAccessRecoveryPlacement,
  RepositoryAccessRequest,
  RepositoryAccessTarget,
  RepositoryAccessTargetView,
} from "./model/repository-access-consumer";
export {
  gitAuthChallengeFromRemoteUrl,
  isGitAuthRequiredError,
} from "./model/remote-auth";
export { GitRemoteAuthDialog } from "./ui/git-remote-auth-dialog";
export {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPreflightDialog,
  RepositoryAccessPrimaryButton,
  repositoryAccessPrimaryActionLabel,
} from "./ui/repository-access-preflight";
export {
  RepositoryAccessBadge,
  RepositoryAccessSummary,
  type RepositoryAccessOwnerKind,
} from "./ui/repository-access-summary";
