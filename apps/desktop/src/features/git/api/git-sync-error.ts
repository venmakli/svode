import {
  toGitSyncFailureDto,
  type GitFailureCauseDto,
  type GitFailureStageDto,
} from "@/platform/git/failure-errors";
import { toGitPublicationBlockDto } from "@/platform/git/publication-errors";
import { toGitPullBlockDto } from "@/platform/git/pull-block-errors";
import { toGitPushRejectionDto } from "@/platform/git/push-rejection-errors";
import { toRepositoryAccessDeniedDto } from "@/platform/git/repository-access-api";
import { redactUrlCredentials } from "../model/remote-auth";
import { gitBranchErrorMessage } from "./git-branch-error";
import type { GitPublicationBlock } from "../model/publication-block";
import type { GitSyncStop } from "../model/sync-stop";
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

/** What the user can do about a recognized cause of a failed Git step. */
export function gitFailureCauseMessage(cause: GitFailureCauseDto): string {
  return {
    hook: m.git_failure_cause_hook,
    signing: m.git_failure_cause_signing,
    identity: m.git_failure_cause_identity,
    index_locked: m.git_failure_cause_index_locked,
    file_system_denied: m.git_failure_cause_file_system_denied,
    network: m.git_failure_cause_network,
    local_changes: m.git_failure_cause_local_changes,
    branch_left_sequence: m.git_failure_cause_branch_left_sequence,
    commits_published: m.git_failure_cause_commits_published,
    state_changed: m.git_failure_cause_state_changed,
  }[cause]();
}

/**
 * The abort was refused because the stop changed after its confirmation
 * listed what is lost (DF-282 R2 (c)): the stop is read again for a retry.
 */
export function isGitAbortStateChanged(error: unknown): boolean {
  const failure = toGitSyncFailureDto(error);
  return failure?.stage === "abort" && failure.cause === "state_changed";
}

function gitSyncStageMessage(stage: GitFailureStageDto): string {
  return {
    prepare: m.git_save_stage_prepare,
    verify: m.git_save_stage_verify,
    commit: m.git_sync_stage_commit,
    fetch: m.git_sync_stage_fetch,
    integrate: m.git_sync_stage_integrate,
    push: m.git_sync_stage_push,
    abort: m.git_sync_stage_abort,
  }[stage]();
}

/** The stop of a publication the guard refused, or `null` for any other error. */
export function toGitPublicationStop(error: unknown): GitSyncStop | null {
  const dto = toGitPublicationBlockDto(error);
  return dto?.reason === "content"
    ? {
        kind: "publication",
        path: dto.path,
        commit: dto.commit,
        finding: dto.finding,
      }
    : null;
}

/** Why the guard refused the publication, with the file and its commit. */
export function gitPublicationStopMessage(
  stop: Pick<Extract<GitSyncStop, { kind: "publication" }>, "finding">,
): string {
  return stop.finding === "conflict_markers"
    ? m.git_sync_stop_publication_markers()
    : m.git_sync_stop_publication_unreadable();
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
    if (publication.reason === "content")
      return m.git_publication_content_blocked({
        reason: gitPublicationStopMessage(publication),
        path: publication.path,
        commit: shortCommit(publication.commit),
      });
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
  const failure = toGitSyncFailureDto(error);
  if (failure)
    return [
      failure.repository ? `${failure.repository}:` : "",
      gitSyncStageMessage(failure.stage),
      failure.cause
        ? gitFailureCauseMessage(failure.cause)
        : m.git_save_cause_unknown(),
    ]
      .filter(Boolean)
      .join(" ");
  const rejection = toGitPushRejectionDto(error);
  if (rejection) {
    switch (rejection.reason) {
      case "lfs_transfer_unconfigured":
        return `${m.git_push_lfs_transfer_unconfigured()} ${m.git_push_lfs_transfer_recovery()}`;
      case "protected_branch":
        return m.git_push_protected_branch();
      case "repository_rules":
        return m.git_push_repository_rules();
      case "non_fast_forward":
        return m.git_push_non_fast_forward();
      case "write_access_denied":
        return m.git_push_write_access_denied();
    }
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

/** The abbreviated commit id the Dialog shows. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}
