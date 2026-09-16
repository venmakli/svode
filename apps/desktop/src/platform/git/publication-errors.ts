export interface GitPublicationBlockDto {
  kind: "git_publication_blocked";
  child: string | null;
  reason:
    | "target_changed"
    | "configuration"
    | "uninitialized_child"
    | "source_unavailable"
    | "revision_unavailable";
}

export function toGitPublicationBlockDto(
  error: unknown,
): GitPublicationBlockDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_publication_blocked" ||
    !("reason" in error)
  )
    return null;
  const { reason } = error;
  switch (reason) {
    case "target_changed":
    case "configuration":
    case "uninitialized_child":
    case "source_unavailable":
    case "revision_unavailable":
      return {
        kind: "git_publication_blocked",
        reason,
        child:
          "child" in error && typeof error.child === "string"
            ? error.child
            : null,
      };
    default:
      return null;
  }
}
