import { toGitBranchBlockDto } from "./branch-errors";
import { toRepositoryAccessDeniedDto } from "./repository-access-api";

export interface GitSaveFailureDto {
  stage: "prepare" | "verify" | "commit";
  reason:
    | "command_unavailable"
    | "command_failed"
    | "inventory_failed"
    | "invalid_path"
    | "local_file_excluded"
    | "target_unavailable"
    | "paths_not_prepared"
    | "verification_failed"
    | "target_cleanup_failed";
  exitCode: number | null;
  pathCount: number;
  pathSample: string | null;
}

export function isGitSavePartial(error: unknown): boolean {
  return isRecord(error) && error.kind === "git_save_partial";
}

export function rethrowGitSaveError(error: unknown): never {
  if (isRecord(error) && isGitSavePartial(error)) {
    throw {
      kind: "git_save_partial",
      childCommitted: true,
      parentPointer: "pending",
      cause: safeCause(error.cause),
    };
  }
  throw safeCause(error);
}

function safeCause(error: unknown) {
  const branch = toGitBranchBlockDto(error);
  if (branch) return branch;
  const failure = toGitSaveFailureDto(error);
  if (failure) return { kind: "git_save_failed", ...failure };
  const denial = toRepositoryAccessDeniedDto(error);
  if (denial) return denial;
  if (isRecord(error) && error.kind === "git_conflict")
    return { kind: "git_conflict" };
  return { kind: "git_save_unknown" };
}

export function toGitSaveFailureDto(error: unknown): GitSaveFailureDto | null {
  const candidate =
    isRecord(error) && isGitSavePartial(error) ? error.cause : error;
  if (!isRecord(candidate) || candidate.kind !== "git_save_failed") return null;
  const { stage, reason, exitCode, pathCount, pathSample } = candidate;
  if (stage !== "prepare" && stage !== "verify" && stage !== "commit")
    return null;
  if (
    reason !== "command_unavailable" &&
    reason !== "command_failed" &&
    reason !== "inventory_failed" &&
    reason !== "invalid_path" &&
    reason !== "local_file_excluded" &&
    reason !== "target_unavailable" &&
    reason !== "paths_not_prepared" &&
    reason !== "verification_failed" &&
    reason !== "target_cleanup_failed"
  )
    return null;
  if (
    typeof pathCount !== "number" ||
    !Number.isSafeInteger(pathCount) ||
    pathCount < 0
  )
    return null;
  return {
    stage,
    reason,
    exitCode:
      typeof exitCode === "number" && Number.isSafeInteger(exitCode)
        ? exitCode
        : null,
    pathCount,
    pathSample: safePathSample(pathSample),
  };
}

function safePathSample(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    value.includes("://")
  )
    return null;
  if (value.split("/").some((part) => part === "." || part === ".." || !part))
    return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const characters = Array.from(value);
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
