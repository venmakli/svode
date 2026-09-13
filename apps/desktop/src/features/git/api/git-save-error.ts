import {
  isGitSavePartial,
  toGitSaveFailureDto,
  type GitSaveFailureDto,
} from "@/platform/git/save-errors";

export interface GitSaveError {
  outcome: "failed" | "partial";
  cause: GitSaveFailureDto | null;
}

export function gitSaveErrorFromError(error: unknown): GitSaveError {
  return {
    outcome: isGitSavePartial(error) ? "partial" : "failed",
    cause: toGitSaveFailureDto(error),
  };
}
