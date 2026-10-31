/** Why a Git save or sync step failed, as the backend recognized it. */
export type GitFailureCauseDto =
  | "hook"
  | "signing"
  | "identity"
  | "index_locked"
  | "file_system_denied"
  | "network";

export type GitFailureStageDto =
  | "prepare"
  | "verify"
  | "commit"
  | "fetch"
  | "integrate"
  | "push";

/** A failed sync step: the repository by its name, the stage and the cause. */
export interface GitSyncFailureDto {
  kind: "git_sync_failed";
  repository: string;
  stage: GitFailureStageDto;
  cause: GitFailureCauseDto | null;
}

const CAUSES: readonly string[] = [
  "hook",
  "signing",
  "identity",
  "index_locked",
  "file_system_denied",
  "network",
] satisfies GitFailureCauseDto[];

const STAGES: readonly string[] = [
  "prepare",
  "verify",
  "commit",
  "fetch",
  "integrate",
  "push",
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
  };
}
