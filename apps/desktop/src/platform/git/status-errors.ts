export interface GitStatusTimeoutDto {
  kind: "git_status_timed_out";
  repository: string;
  seconds: number;
}

export function toGitStatusTimeoutDto(
  error: unknown,
): GitStatusTimeoutDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_status_timed_out" ||
    !("repository" in error) ||
    typeof error.repository !== "string" ||
    !("seconds" in error) ||
    typeof error.seconds !== "number"
  )
    return null;
  return {
    kind: "git_status_timed_out",
    repository: error.repository,
    seconds: error.seconds,
  };
}
