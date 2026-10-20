import { toGitPublicationBlockDto } from "@/platform/git/publication-errors";
import { toGitPullBlockDto } from "@/platform/git/pull-block-errors";
import { toGitPushRejectionDto } from "@/platform/git/push-rejection-errors";
import { toRepositoryAccessDeniedDto } from "@/platform/git/repository-access-api";
import { redactUrlCredentials } from "../model/remote-auth";
import { gitBranchErrorMessage } from "./git-branch-error";
import type { GitPublicationBlock } from "../model/publication-block";
import * as m from "@/paraglide/messages.js";

/** The Spaces a publication refusal names, or `null` for any other error. */
export function toGitPublicationBlock(
  error: unknown,
): GitPublicationBlock | null {
  const dto = toGitPublicationBlockDto(error);
  return dto?.reason === "spaces"
    ? { project: dto.repository, spaces: dto.spaces }
    : null;
}

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
    if (publication.reason !== "spaces")
      return {
        target_changed: m.git_publication_target_changed,
        configuration: m.git_sync_publication_configuration,
        source_unavailable: m.git_sync_publication_source_unavailable,
        revision_unavailable: m.git_publication_revision_unavailable,
      }[publication.reason]();
    return m.git_sync_publication_blocked_status();
  }
  const pullBlock = toGitPullBlockDto(error);
  if (pullBlock)
    return m.git_sync_pull_blocked({ files: pullBlock.files.join(", ") });
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
