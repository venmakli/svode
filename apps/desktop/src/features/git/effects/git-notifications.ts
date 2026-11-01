import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { gitSaveErrorFromError } from "../api/git-save-error";
import { toGitPublicationBlock } from "../api/git-sync-error";
import { syncStopFromResult, type GitSyncOutcome } from "../model";
import type { GitCommitRefusal } from "../model/page-save-owner";
import { gitSaveErrorDescription } from "../ui/git-save-error-copy";
import {
  gitServiceMergedMessage,
  gitSyncStopTitle,
} from "../ui/git-sync-stop-copy";

export function notifyGitSyncConflict(fileCount: number): void {
  toast.error(m.git_sync_conflict({ count: String(fileCount) }));
}

export function notifyGitSyncAuthRequired(): void {
  toast.error(m.git_sync_auth_required());
}

export function notifyGitSyncFailed(): void {
  toast.error(m.git_sync_failed());
}

/** The sync result names the Svode service files it merged. */
function notifyGitServiceMerged(files: string[] | undefined): void {
  if (files?.length) toast.info(gitServiceMergedMessage(files));
}

export function notifyGitSyncOutcome(outcome: GitSyncOutcome): void {
  if (outcome.type === "Success" || outcome.type === "Conflict")
    notifyGitServiceMerged(outcome.merged);
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
      // Spaces and the publication guard stop publication; not a failure.
      if (outcome.block) toast.info(m.git_sync_publication_blocked_status());
      else if (outcome.stop) toast.info(gitSyncStopTitle(outcome.stop));
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
    case "IntegrationAfterTurn":
      toast.info(m.git_sync_integration_after_turn());
      break;
    // A background stop: the indicator shows it, work goes on; a file that
    // refused the choice shows why.
    case "IncomingConflict":
    case "ExplicitSyncRequired":
    case "Resolved":
    case "NoRemote":
    case "Unresolved":
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

/**
 * A refused commit of a save shortcut, named by repository, stage and cause
 * in the words of "Changes"; what the save wrote stays saved.
 */
export function notifyGitSaveFailure(error: unknown): void {
  const failure = gitSaveErrorFromError(error);
  const description = gitSaveErrorDescription(failure);
  if (failure.outcome === "partial")
    toast.error(m.changes_partial(), { description });
  else toast.error(description);
}
