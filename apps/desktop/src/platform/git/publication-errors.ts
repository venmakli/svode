export type GitPublicationProjectReason =
  | "target_changed"
  | "configuration"
  | "source_unavailable"
  | "revision_unavailable";

export type GitPublicationSpaceClass =
  | "local_commits"
  | "unverified"
  | "source_unavailable"
  | "uninitialized"
  | "configuration"
  | "outside_branch"
  | "missing";

export interface GitPublicationBlockedSpaceDto {
  path: string;
  class: GitPublicationSpaceClass;
}

/** What the publication guard refuses to publish. */
export type GitPublicationContentFinding = "conflict_markers" | "unreadable";

export type GitPublicationBlockDto =
  | { kind: "git_publication_blocked"; reason: GitPublicationProjectReason }
  | {
      kind: "git_publication_blocked";
      reason: "spaces";
      /** The project repository whose gitlinks name these Spaces. */
      repository: string;
      spaces: GitPublicationBlockedSpaceDto[];
    }
  | {
      kind: "git_publication_blocked";
      reason: "content";
      /** The file relative to the repository, as the commit left it. */
      path: string;
      commit: string;
      finding: GitPublicationContentFinding;
    };

const spaceClasses = new Set<string>([
  "local_commits",
  "unverified",
  "source_unavailable",
  "uninitialized",
  "configuration",
  "outside_branch",
  "missing",
]);

function toBlockedSpace(value: unknown): GitPublicationBlockedSpaceDto | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("class" in value) ||
    typeof value.class !== "string" ||
    !spaceClasses.has(value.class)
  )
    return null;
  return {
    path: value.path,
    class: value.class as GitPublicationSpaceClass,
  };
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
    case "source_unavailable":
    case "revision_unavailable":
      return { kind: "git_publication_blocked", reason };
    case "spaces": {
      if (
        !("repository" in error) ||
        typeof error.repository !== "string" ||
        !("spaces" in error) ||
        !Array.isArray(error.spaces)
      )
        return null;
      const spaces = error.spaces
        .map(toBlockedSpace)
        .filter((space) => space !== null);
      if (spaces.length === 0 || spaces.length !== error.spaces.length)
        return null;
      return {
        kind: "git_publication_blocked",
        reason,
        repository: error.repository,
        spaces,
      };
    }
    case "content":
      if (
        !("path" in error) ||
        typeof error.path !== "string" ||
        !("commit" in error) ||
        typeof error.commit !== "string" ||
        !("finding" in error) ||
        (error.finding !== "conflict_markers" && error.finding !== "unreadable")
      )
        return null;
      return {
        kind: "git_publication_blocked",
        reason,
        path: error.path,
        commit: error.commit,
        finding: error.finding,
      };
    default:
      return null;
  }
}
