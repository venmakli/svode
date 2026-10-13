export interface GitPullBlockDto {
  kind: "git_pull_blocked";
  repository: string;
  files: string[];
}

export function toGitPullBlockDto(error: unknown): GitPullBlockDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_pull_blocked" ||
    !("repository" in error) ||
    typeof error.repository !== "string" ||
    !("files" in error) ||
    !Array.isArray(error.files)
  )
    return null;
  const files = error.files.filter(
    (file): file is string => typeof file === "string",
  );
  return files.length > 0
    ? { kind: "git_pull_blocked", repository: error.repository, files }
    : null;
}
