import type { GitTransferDirectionDto } from "./git-types";

/** Why a Git save or sync step failed, as the backend recognized it. */
export type GitFailureCauseDto =
  | "hook"
  | "signing"
  | "identity"
  | "index_locked"
  | "file_system_denied"
  | "network"
  | "file_server_unreachable"
  | "timed_out"
  | "transfer_stalled"
  | "local_changes"
  | "branch_left_sequence"
  | "commits_published"
  | "state_changed";

export type GitFailureStageDto =
  | "prepare"
  | "verify"
  | "commit"
  | "fetch"
  | "integrate"
  | "push"
  | "abort";

/**
 * The transfer Svode stopped without progress (`transfer_stalled`), with the
 * last file its report named, relative to the repository.
 */
export interface GitTransferStallDto {
  direction: GitTransferDirectionDto;
  path: string | null;
  size: number | null;
}

/** A failed sync step: the repository by its name, the stage and the cause. */
export interface GitSyncFailureDto {
  kind: "git_sync_failed";
  repository: string;
  stage: GitFailureStageDto;
  cause: GitFailureCauseDto | null;
  transfer: GitTransferStallDto | null;
}

const CAUSES: readonly string[] = [
  "hook",
  "signing",
  "identity",
  "index_locked",
  "file_system_denied",
  "network",
  "file_server_unreachable",
  "timed_out",
  "transfer_stalled",
  "local_changes",
  "branch_left_sequence",
  "commits_published",
  "state_changed",
] satisfies GitFailureCauseDto[];

const STAGES: readonly string[] = [
  "prepare",
  "verify",
  "commit",
  "fetch",
  "integrate",
  "push",
  "abort",
] satisfies GitFailureStageDto[];

export function toGitFailureCause(value: unknown): GitFailureCauseDto | null {
  return typeof value === "string" && CAUSES.includes(value)
    ? (value as GitFailureCauseDto)
    : null;
}

/** The Space or project name the backend gave a failure, never a path. */
export function toGitFailureRepository(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return /[\p{Cc}\p{Cf}]/u.test(value) ? null : value;
}

function toGitTransferStall(value: unknown): GitTransferStallDto | null {
  if (!value || typeof value !== "object") return null;
  const direction = "direction" in value ? value.direction : null;
  if (direction !== "upload" && direction !== "download") return null;
  const path = "path" in value ? value.path : null;
  const size = "size" in value ? value.size : null;
  return {
    direction,
    path: typeof path === "string" && path ? path : null,
    size: typeof size === "number" && Number.isFinite(size) ? size : null,
  };
}

export function toGitSyncFailureDto(error: unknown): GitSyncFailureDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_sync_failed" ||
    !("stage" in error) ||
    typeof error.stage !== "string" ||
    !STAGES.includes(error.stage)
  )
    return null;
  return {
    kind: "git_sync_failed",
    repository:
      toGitFailureRepository("repository" in error ? error.repository : null) ??
      "",
    stage: error.stage as GitFailureStageDto,
    cause: toGitFailureCause("cause" in error ? error.cause : null),
    transfer: toGitTransferStall("transfer" in error ? error.transfer : null),
  };
}
