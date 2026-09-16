import * as m from "@/paraglide/messages.js";
import { toGitBranchBlockDto } from "@/platform/git/branch-errors";

export function gitBranchErrorMessage(error: unknown): string | null {
  const block = toGitBranchBlockDto(error);
  if (!block) return null;
  const reason = {
    configuration: m.git_branch_configuration,
    root_detached: m.git_branch_root_detached,
    remote_unavailable: m.git_branch_remote_unavailable,
    missing_branch: m.git_branch_missing_branch,
    local_changes: m.git_branch_local_changes,
    operation_in_progress: m.git_branch_operation_in_progress,
    local_history: m.git_branch_local_history,
    incompatible_branch: m.git_branch_incompatible_branch,
    checkout_failed: m.git_branch_checkout_failed,
  }[block.reason]();
  return `${reason} ${m.git_branch_recovery()}`;
}
