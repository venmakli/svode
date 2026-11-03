/** Resolving a path was refused because marker lines remain in its file. */
export interface GitConflictMarkersDto {
  kind: "git_conflict";
  reason: "markers";
  /** The path relative to the repository. */
  path: string;
}

export function toGitConflictMarkersDto(
  error: unknown,
): GitConflictMarkersDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_conflict" ||
    !("reason" in error) ||
    error.reason !== "markers" ||
    !("path" in error) ||
    typeof error.path !== "string"
  )
    return null;
  return { kind: "git_conflict", reason: "markers", path: error.path };
}
