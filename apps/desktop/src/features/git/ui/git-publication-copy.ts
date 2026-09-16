import * as m from "@/paraglide/messages.js";
import type { GitPublicationStatus } from "../model";
import { gitSyncErrorMessage } from "../api/git-sync-error";

export function publicationCopy(publication: GitPublicationStatus) {
  const { parent, child } = publication;
  const summary =
    parent.pointer === "published" && child === "published"
      ? m.git_sync_success()
      : child === "published"
        ? m.git_publication_partial()
        : m.git_publication_local_summary();
  let reason: string | null = null;
  if (parent.error?.kind === "repository_access_denied")
    reason =
      parent.error.status === "read_only"
        ? m.git_publication_read_only()
        : m.git_publication_unknown();
  else if (parent.result?.type === "Conflict")
    reason = m.git_publication_conflict();
  else if (parent.result?.type === "AuthRequired")
    reason = m.git_publication_auth();
  else if (parent.result?.type === "NoRemote")
    reason = m.git_publication_no_remote();
  else if (parent.error) reason = gitSyncErrorMessage(parent.error);
  else if (parent.policySkipped) reason = m.git_publication_policy();
  return {
    summary,
    child:
      child === "published"
        ? m.git_publication_child_published()
        : child === "local"
          ? m.git_publication_child_local()
          : m.git_publication_child_unpublished(),
    parent:
      parent.pointer === "published"
        ? m.git_publication_parent_published()
        : parent.pointer === "local"
          ? m.git_publication_parent_local()
          : m.git_publication_parent_pending(),
    reason,
  };
}
