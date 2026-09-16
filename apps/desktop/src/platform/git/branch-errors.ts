export interface GitBranchBlockDto {
  kind: "git_branch_blocked";
  reason:
    | "configuration"
    | "root_detached"
    | "remote_unavailable"
    | "missing_branch"
    | "local_changes"
    | "operation_in_progress"
    | "local_history"
    | "incompatible_branch"
    | "checkout_failed";
}

export function toGitBranchBlockDto(error: unknown): GitBranchBlockDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_branch_blocked" ||
    !("reason" in error)
  )
    return null;
  const { reason } = error;
  switch (reason) {
    case "configuration":
    case "root_detached":
    case "remote_unavailable":
    case "missing_branch":
    case "local_changes":
    case "operation_in_progress":
    case "local_history":
    case "incompatible_branch":
    case "checkout_failed":
      return { kind: "git_branch_blocked", reason };
    default:
      return null;
  }
}
