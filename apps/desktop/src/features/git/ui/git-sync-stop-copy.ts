import * as m from "@/paraglide/messages.js";
import type { GitServiceFile, GitSyncStop } from "../model";

export function gitSyncStopTitle(stop: GitSyncStop): string {
  if (stop.kind === "publication") return m.git_sync_stop_publication_title();
  if (stop.kind === "commit") return m.git_sync_stop_commit_title();
  if (stop.kind !== "operation") return m.git_sync_stop_conflict_title();
  // Git names its operations; only the sequencer has no command of its own.
  const operation = {
    rebase: "rebase",
    cherry_pick: "cherry-pick",
    revert: "revert",
    sequencer: m.git_sync_stop_operation_sequencer(),
  }[stop.operation];
  return m.git_sync_stop_operation_title({ operation });
}

/** What the rule set of Svode service files says about a conflicted one. */
export function gitServiceFileLabel(file: GitServiceFile): string {
  switch (file.state) {
    case "mergeable":
      return m.git_sync_service_mergeable();
    case "space_diverged":
      return m.git_sync_service_space_diverged();
    case "space_unavailable":
      return m.git_sync_service_space_unavailable();
  }
}

/** The sync result names the Svode service files it merged. */
export function gitServiceMergedMessage(files: string[]): string {
  return m.git_sync_service_merged({ files: files.join(", ") });
}
