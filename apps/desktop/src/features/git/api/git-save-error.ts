import {
  isGitSavePartial,
  toGitSaveFailureDto,
  type GitSaveFailureDto,
} from "@/platform/git/save-errors";

import { gitBranchErrorMessage } from "./git-branch-error";

export interface GitSaveError {
  branchMessage?: string | null;
  outcome: "failed" | "partial";
  cause: GitSaveFailureDto | null;
}

export function gitSaveErrorFromError(error: unknown): GitSaveError {
  return {
    outcome: isGitSavePartial(error) ? "partial" : "failed",
    cause: toGitSaveFailureDto(error),
    branchMessage: gitBranchErrorMessage(error),
  };
}
