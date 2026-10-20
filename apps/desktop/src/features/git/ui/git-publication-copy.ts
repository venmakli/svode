import * as m from "@/paraglide/messages.js";
import type { GitPublicationStatus } from "../model";
import {
  gitSyncErrorMessage,
  toGitPublicationBlock,
} from "../api/git-sync-error";
import { gitSyncStopTitle } from "./git-sync-stop-copy";

export function publicationCopy(publication: GitPublicationStatus) {
  const { parent, child } = publication;
  const newer = parent.pointer === "newer";
  const held = parent.unpublishedCommits !== undefined;
  // The Spaces that stopped the project are listed by the result itself.
  const block = toGitPublicationBlock(parent.error);
  const summary = newer
    ? m.git_publication_newer_summary()
    : parent.pointer === "published" && child === "published"
      ? m.git_sync_success()
      : child === "unknown"
        ? m.git_publication_unchecked_summary()
        : child === "published"
          ? held && parent.pointer === "local"
            ? m.git_publication_held_summary()
            : block
              ? m.git_publication_blocked_summary()
              : m.git_publication_partial()
          : m.git_publication_local_summary();
  let reason: string | null = null;
  if (parent.error?.kind === "repository_access_denied")
    reason =
      parent.error.status === "read_only"
        ? m.git_publication_read_only()
        : m.git_publication_unknown();
  else if (parent.result?.type === "Conflict")
    reason = m.git_publication_conflict();
  else if (parent.result?.type === "OperationInProgress")
    reason = `${gitSyncStopTitle({ kind: "operation", operation: parent.result.operation })}. ${m.git_sync_stop_operation_description()}`;
  else if (parent.result?.type === "AuthRequired")
    reason = m.git_publication_auth();
  else if (parent.result?.type === "NoRemote")
    reason = m.git_publication_no_remote();
  else if (parent.error && !block) reason = gitSyncErrorMessage(parent.error);
  else if (held)
    reason = m.git_publication_held({
      count: String(parent.unpublishedCommits),
    });
  else if (parent.policySkipped) reason = m.git_publication_policy();
  return {
    summary,
    child:
      child === "published"
        ? m.git_publication_child_published()
        : child === "unknown"
          ? m.git_publication_child_unknown()
          : child === "local"
            ? m.git_publication_child_local()
            : m.git_publication_child_unpublished(),
    parent:
      parent.pointer === "published"
        ? m.git_publication_parent_published()
        : parent.pointer === "local"
          ? m.git_publication_parent_local()
          : newer
            ? m.git_publication_parent_newer()
            : m.git_publication_parent_pending(),
    // Project-side causes do not apply while the project already holds a newer version.
    reason: newer ? null : reason,
    block: newer ? null : block,
  };
}
