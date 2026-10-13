import type { GitPublicationStatus, GitSyncOutcome } from "./types";

export function isFullSyncSuccess(outcome: GitSyncOutcome) {
  return (
    outcome.type === "Success" &&
    (!outcome.parent || outcome.parent.pointer === "published")
  );
}

/** The project version still waits for this Space's revision. */
export function isParentPointerPending(
  publication: GitPublicationStatus | undefined,
) {
  return (
    !!publication &&
    publication.parent.pointer !== "published" &&
    publication.parent.pointer !== "newer"
  );
}

export function parentRecoveryAction(
  publication: GitPublicationStatus | undefined,
) {
  // A project pointer newer than this Space is never moved back; syncing the Space catches up.
  if (
    !publication ||
    !isParentPointerPending(publication) ||
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
