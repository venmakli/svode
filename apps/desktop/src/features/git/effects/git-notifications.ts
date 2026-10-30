import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { toGitPublicationBlock } from "../api/git-sync-error";
import { syncStopFromResult, type GitSyncOutcome } from "../model";
import type { GitCommitRefusal } from "../model/page-save-owner";
import { gitSyncStopTitle } from "../ui/git-sync-stop-copy";

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
    case "UnmergedFiles":
      notifyGitSyncConflict(outcome.files.length);
      break;
    case "AuthRequired":
      notifyGitSyncAuthRequired();
      break;
    case "OperationInProgress": {
      const stop = syncStopFromResult(outcome);
      if (stop)
        toast.info(gitSyncStopTitle(stop), {
          description: m.git_sync_stop_operation_description(),
        });
      break;
    }
    case "Failed":
      // Spaces that stop the project publication are a stop, not a failure.
      if (outcome.block) toast.info(m.git_sync_publication_blocked_status());
      else notifyGitSyncFailed();
      break;
    case "Success":
      if (outcome.parent?.pointer === "newer")
        toast.info(m.git_publication_newer_summary());
      else if (outcome.parent?.unpublishedCommits !== undefined)
        toast.info(m.git_publication_held_summary());
      else if (outcome.parent && outcome.parent.pointer !== "published")
        toast.info(
          toGitPublicationBlock(outcome.parent.error)
            ? m.git_publication_blocked_summary()
            : m.git_publication_partial(),
        );
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

/** A refused explicit commit outside the Page and "Changes": names the Page and leads to its version choice. */
export function notifyGitCommitRefusal(refusal: GitCommitRefusal): void {
  toast.warning(
    m.git_commit_refused_source_conflict({ title: refusal.title }),
    {
      action: {
        label: m.git_commit_refused_choose_version(),
        onClick: () => refusal.chooseVersion(),
      },
    },
  );
}
