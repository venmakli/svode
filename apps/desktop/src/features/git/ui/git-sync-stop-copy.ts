import * as m from "@/paraglide/messages.js";
import type { GitConflictKind, GitServiceFile, GitSyncStop } from "../model";

export function gitSyncStopTitle(stop: GitSyncStop): string {
  if (stop.kind === "publication") return m.git_sync_stop_publication_title();
  if (stop.kind === "commit") return m.git_sync_stop_commit_title();
  if (stop.kind === "incoming") return m.git_sync_stop_incoming_title();
  if (stop.kind === "explicit_sync") return m.git_sync_stop_explicit_title();
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

/** The kind of a conflicted path, as the stop lists it. */
export function gitConflictKindLabel(kind: GitConflictKind): string {
  switch (kind) {
    case "page_text":
      return m.git_conflict_kind_page_text();
    case "page_properties":
      return m.git_conflict_kind_page_properties();
    case "text":
      return m.git_conflict_kind_text();
    case "binary":
      return m.git_conflict_kind_binary();
    case "modify_delete":
      return m.git_conflict_kind_modify_delete();
    case "add_add":
      return m.git_conflict_kind_add_add();
    case "rename_rename":
      return m.git_conflict_kind_rename_rename();
    case "rename_delete":
      return m.git_conflict_kind_rename_delete();
    case "space_pointer":
      return m.git_conflict_kind_space_pointer();
  }
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
