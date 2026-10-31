import * as m from "@/paraglide/messages.js";
import type {
  GitConflictKind,
  GitOperation,
  GitOperationStep,
  GitServiceFile,
  GitSyncStop,
} from "../model";

export function gitSyncStopTitle(stop: GitSyncStop): string {
  if (stop.kind === "publication") return m.git_sync_stop_publication_title();
  if (stop.kind === "commit") return m.git_sync_stop_commit_title();
  if (stop.kind === "incoming") return m.git_sync_stop_incoming_title();
  if (stop.kind === "explicit_sync") return m.git_sync_stop_explicit_title();
  if (stop.kind !== "operation") return m.git_sync_stop_conflict_title();
  return gitOperationStopTitle(stop.operation);
}

/** «Идёт операция Git: <операция>». */
export function gitOperationStopTitle(operation: GitOperation): string {
  return m.git_sync_stop_operation_title({
    operation: gitOperationName(operation),
  });
}

/**
 * The operation as the person knows it: Git names its operations; only the
 * sequencer has no command of its own.
 */
export function gitOperationName(operation: GitOperation): string {
  return {
    rebase: "rebase",
    cherry_pick: "cherry-pick",
    revert: "revert",
    sequencer: m.git_sync_stop_operation_sequencer(),
  }[operation];
}

/**
 * «Отменить <операцию>» and its confirmation (Stage 11 1.F), which names what
 * is lost: the resolutions and edits after the stop, and for a sequence the
 * commits it already applied; commits made before it stay.
 */
export function gitOperationAbortCopy(
  operation: GitOperation,
  step: GitOperationStep | null,
): { action: string; title: string; description: string } {
  // A pick or revert with a todo is a sequence: Git returns the branch to
  // the state before all of it.
  const sequence = operation === "sequencer" || step?.kind === "remaining";
  const action =
    operation === "sequencer"
      ? m.git_operation_abort_sequence_action()
      : m.git_operation_abort_action({
          operation: gitOperationName(operation),
        });
  return {
    action,
    title: m.git_operation_abort_title({ action }),
    description: sequence
      ? m.git_operation_abort_sequence_description()
      : m.git_operation_abort_description({
          operation: gitOperationName(operation),
        }),
  };
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
