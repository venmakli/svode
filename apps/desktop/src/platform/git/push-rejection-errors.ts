import type { LfsDeclarationStateDto } from "@/platform/space/space-types";

export type GitPushRejectionDto =
  | {
      kind: "git_push_rejected";
      reason: "lfs_objects_missing";
      objectCount: number;
      lfsDeclaration: LfsDeclarationStateDto | null;
    }
  | {
      kind: "git_push_rejected";
      reason:
        | "lfs_transfer_unconfigured"
        | "protected_branch"
        | "repository_rules"
        | "non_fast_forward";
    };

const DECLARATION_STATES: readonly string[] = [
  "published",
  "pending",
  "missing",
  "foreign",
] satisfies LfsDeclarationStateDto[];

export function toGitPushRejectionDto(
  error: unknown,
): GitPushRejectionDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "git_push_rejected" ||
    !("reason" in error)
  )
    return null;
  switch (error.reason) {
    case "lfs_objects_missing": {
      const count =
        "objectCount" in error && typeof error.objectCount === "number"
          ? error.objectCount
          : 1;
      const state =
        "lfsDeclaration" in error &&
        typeof error.lfsDeclaration === "string" &&
        DECLARATION_STATES.includes(error.lfsDeclaration)
          ? (error.lfsDeclaration as LfsDeclarationStateDto)
          : null;
      return {
        kind: "git_push_rejected",
        reason: "lfs_objects_missing",
        objectCount: count,
        lfsDeclaration: state,
      };
    }
    case "lfs_transfer_unconfigured":
    case "protected_branch":
    case "repository_rules":
    case "non_fast_forward":
      return { kind: "git_push_rejected", reason: error.reason };
    default:
      return null;
  }
}
