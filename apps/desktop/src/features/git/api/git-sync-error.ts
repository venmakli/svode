import { toGitPublicationBlockDto } from "@/platform/git/publication-errors";
import { toGitPushRejectionDto } from "@/platform/git/push-rejection-errors";
import { toRepositoryAccessDeniedDto } from "@/platform/git/repository-access-api";
import { redactUrlCredentials } from "../model/remote-auth";
import { gitBranchErrorMessage } from "./git-branch-error";
import * as m from "@/paraglide/messages.js";

export function gitSyncErrorMessage(error: unknown): string {
  const branch = gitBranchErrorMessage(error);
  if (branch) return branch;
  const access = toRepositoryAccessDeniedDto(error);
  if (access)
    return access.status === "read_only"
      ? m.git_sync_access_read_only()
      : m.git_sync_access_unknown();
  const publication = toGitPublicationBlockDto(error);
  if (publication) {
    const reason = {
      target_changed: m.git_publication_target_changed,
      configuration: m.git_sync_publication_configuration,
      uninitialized_child: m.git_sync_publication_uninitialized,
      source_unavailable: m.git_sync_publication_source_unavailable,
      revision_unavailable: m.git_publication_revision_unavailable,
    }[publication.reason]();
    return publication.child ? `${publication.child}: ${reason}` : reason;
  }
  const rejection = toGitPushRejectionDto(error);
  if (rejection) {
    if (rejection.reason === "lfs_transfer_unconfigured")
      return `${m.git_push_lfs_transfer_unconfigured()} ${m.git_push_lfs_transfer_recovery()}`;
    // Only lfs-s3 carries a declaration state; other strategies get neutral copy.
    const action = rejection.lfsDeclaration
      ? {
          missing: m.git_push_lfs_recovery_missing,
          pending: m.git_push_lfs_recovery_pending,
          foreign: m.git_push_lfs_recovery_foreign,
          published: m.git_push_lfs_recovery_published,
        }[rejection.lfsDeclaration]()
      : m.git_push_lfs_recovery_generic();
    return `${m.git_push_lfs_objects_missing({ count: rejection.objectCount })} ${action}`;
  }
  if (error === "auth") return m.git_sync_auth_required();
  if (error === "conflict") return m.git_sync_conflict_recovery();
  const detail =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : null;
  return detail?.trim()
    ? redactUrlCredentials(detail).trim().slice(0, 4000)
    : m.git_sync_failed();
}
