import { toast } from "sonner";

import { repositoryBlockersNotice } from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type { PageWarning } from "../model/types";

const REPOSITORY_ACCESS_DENIED_REASON = "repository_access_denied";

const FILENAME_WARNING_KINDS = new Set([
  "filename_projection",
  "filename_collision_allocated",
  "filename_rename_collision",
  "filename_rename_deferred",
]);

export function retargetPageFilenameWarnings(
  warnings: readonly PageWarning[] | undefined,
  actualPath: string,
): PageWarning[] | undefined {
  return warnings?.map((warning) =>
    FILENAME_WARNING_KINDS.has(warning.kind)
      ? { ...warning, path: actualPath }
      : warning,
  );
}

export function publishPageFilenameWarnings(
  warnings: readonly PageWarning[] | undefined,
) {
  for (const warning of warnings ?? []) {
    const feedback = pageFilenameWarningFeedback(warning);
    if (feedback) {
      toast.warning(feedback.title, {
        description: feedback.description,
        action: feedback.action,
      });
    }
  }
}

export interface PageFilenameWarningFeedback {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function pageFilenameWarningFeedback(
  warning: PageWarning,
): PageFilenameWarningFeedback | null {
  if (warning.kind === "filename_projection") {
    return {
      title: m.page_filename_adjusted(),
      description: warning.path
        ? m.page_filename_adjusted_description({ path: warning.path })
        : warning.message,
    };
  } else if (warning.kind === "filename_collision_allocated") {
    return {
      title: m.page_filename_collision(),
      description: warning.path
        ? m.page_filename_allocated_description({ path: warning.path })
        : warning.message,
    };
  } else if (warning.kind === "filename_rename_collision") {
    return {
      title: m.page_filename_collision(),
      description: warning.path
        ? m.page_filename_collision_description({ path: warning.path })
        : warning.message,
    };
  } else if (
    warning.kind === "filename_rename_deferred" &&
    warning.reason === REPOSITORY_ACCESS_DENIED_REASON &&
    warning.path &&
    warning.blockers?.length
  ) {
    const notice = repositoryBlockersNotice(warning.blockers);
    return {
      title: m.page_filename_rename_deferred(),
      description: m.page_filename_rename_access_deferred_description({
        path: warning.path,
        repositories: notice.repositories,
      }),
      action: notice.settingsAction,
    };
  } else if (warning.kind === "filename_rename_deferred") {
    return {
      title: m.page_filename_rename_deferred(),
      description: warning.path
        ? `${m.page_filename_rename_deferred_description({ path: warning.path })} ${warning.message}`
        : warning.message,
    };
  }
  return null;
}
