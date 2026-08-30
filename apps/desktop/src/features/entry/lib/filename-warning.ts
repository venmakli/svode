import { toast } from "sonner";

import * as m from "@/paraglide/messages.js";

import type { EntryWarning } from "../model/types";

const FILENAME_WARNING_KINDS = new Set([
  "filename_projection",
  "filename_collision_allocated",
  "filename_rename_collision",
  "filename_rename_deferred",
]);

export function retargetEntryFilenameWarnings(
  warnings: readonly EntryWarning[] | undefined,
  actualPath: string,
): EntryWarning[] | undefined {
  return warnings?.map((warning) =>
    FILENAME_WARNING_KINDS.has(warning.kind)
      ? { ...warning, path: actualPath }
      : warning,
  );
}

export function publishEntryFilenameWarnings(
  warnings: readonly EntryWarning[] | undefined,
) {
  for (const warning of warnings ?? []) {
    const feedback = entryFilenameWarningFeedback(warning);
    if (feedback) {
      toast.warning(feedback.title, { description: feedback.description });
    }
  }
}

export function entryFilenameWarningFeedback(
  warning: EntryWarning,
): { title: string; description: string } | null {
  if (warning.kind === "filename_projection") {
    return {
      title: m.entry_filename_adjusted(),
      description: warning.path
        ? m.entry_filename_adjusted_description({ path: warning.path })
        : warning.message,
    };
  } else if (warning.kind === "filename_collision_allocated") {
    return {
      title: m.entry_filename_collision(),
      description: warning.path
        ? m.entry_filename_allocated_description({ path: warning.path })
        : warning.message,
    };
  } else if (warning.kind === "filename_rename_collision") {
    return {
      title: m.entry_filename_collision(),
      description: warning.path
        ? m.entry_filename_collision_description({ path: warning.path })
        : warning.message,
    };
  } else if (warning.kind === "filename_rename_deferred") {
    return {
      title: m.entry_filename_rename_deferred(),
      description: warning.path
        ? m.entry_filename_rename_deferred_description({ path: warning.path })
        : warning.message,
    };
  }
  return null;
}
