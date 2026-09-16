import type { GitPublicationStatus, GitSyncOutcome } from "./types";

export function isFullSyncSuccess(outcome: GitSyncOutcome) {
  return (
    outcome.type === "Success" &&
    (!outcome.parent || outcome.parent.pointer === "published")
  );
}

export function parentRecoveryAction(
  publication: GitPublicationStatus | undefined,
) {
  if (
    !publication ||
    publication.parent.pointer === "published" ||
    publication.child !== "published"
  )
    return "sync";
  const { parent } = publication;
  if (parent.error?.kind === "repository_access_denied") {
    return parent.error.status === "read_only" ? "none" : "verify";
  }
  if (parent.result?.type === "AuthRequired") return "authenticate";
  if (parent.result?.type === "Conflict") return "resolve";
  return "retry";
}
