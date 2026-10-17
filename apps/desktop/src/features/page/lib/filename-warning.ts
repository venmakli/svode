import { toast } from "sonner";

import { repositoryBlockerNames } from "@/features/git";
import * as m from "@/paraglide/messages.js";

import {
  usePageFilenameWarningDetails,
  type PageFilenameWarningDetails,
} from "../model/filename-warning-details";
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
      const { details } = feedback;
      toast.warning(feedback.title, {
        description: feedback.description,
        action: details && {
          label: m.page_filename_details_action(),
          onClick: () => usePageFilenameWarningDetails.getState().show(details),
        },
      });
    }
  }
}

export interface PageFilenameWarningFeedback {
  title: string;
  /** One line: the resulting path, or the cause of a deferred rename. */
  description: string;
  /** The explanation of a deferred rename behind "Details". */
  details?: PageFilenameWarningDetails;
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
    warning.blockers?.length
  ) {
    return {
      title: m.page_filename_rename_deferred(),
      description: m.page_filename_rename_access_deferred_description({
        repositories: repositoryBlockerNames(warning.blockers),
      }),
      details: {
        path: warning.path ?? null,
        cause: { kind: "access", blockers: warning.blockers },
      },
    };
  } else if (warning.kind === "filename_rename_deferred") {
    return {
      title: m.page_filename_rename_deferred(),
      description: m.page_filename_rename_deferred_description(),
      details: {
        path: warning.path ?? null,
        cause: { kind: "dependencies", message: warning.message },
      },
    };
  }
  return null;
}
