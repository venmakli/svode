import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { GitSyncOutcome } from "../model";

export function notifyGitSyncConflict(fileCount: number): void {
  toast.error(m.git_sync_conflict({ count: String(fileCount) }));
}

export function notifyGitSyncAuthRequired(): void {
  toast.error(m.git_sync_auth_required());
}

export function notifyGitSyncFailed(): void {
  toast.error(m.git_sync_failed());
}

export function notifyGitSyncOutcome(outcome: GitSyncOutcome): void {
  switch (outcome.type) {
    case "Conflict":
      notifyGitSyncConflict(outcome.files.length);
      break;
    case "AuthRequired":
      notifyGitSyncAuthRequired();
      break;
    case "Failed":
      notifyGitSyncFailed();
      break;
    case "Success":
      if (outcome.parent?.pointer === "newer")
        toast.info(m.git_publication_newer_summary());
      else if (outcome.parent && outcome.parent.pointer !== "published")
        toast.info(m.git_publication_partial());
      break;
    case "Resolved":
    case "NoRemote":
      break;
  }
}

export function notifyGitResolveOutcome(
  outcome: GitSyncOutcome,
  page: string,
): void {
  if (outcome.type === "Conflict") {
    toast.info(
      m.git_resolve_conflicts_remaining({
        page,
        count: String(outcome.files.length),
      }),
    );
    return;
  }
  notifyGitSyncOutcome(outcome);
}
