import {
  repositoryAccessPresentation,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type { PageSourceConflict } from "../model/source-conflict";

/**
 * Why the Page session holds an unsaved draft, by its leading cause: a source
 * conflict, then a refused repository access, then a busy or failed write.
 */
export type PageSaveBlock =
  | { kind: "conflict"; conflict: PageSourceConflict }
  | { kind: "access"; recovery: RepositoryAccessPreflightController }
  | { kind: "write"; reason: string };

export function pageSaveBlock({
  ownerError = null,
  persistenceError,
  recovery,
  sourceConflict,
}: {
  /** A failed write of the detail owner the session does not present itself. */
  ownerError?: string | null;
  persistenceError: string | null;
  recovery: RepositoryAccessPreflightController;
  sourceConflict: PageSourceConflict | null;
}): PageSaveBlock | null {
  if (sourceConflict) return { kind: "conflict", conflict: sourceConflict };
  if (recovery.open && recovery.pending?.placement === "inline")
    return { kind: "access", recovery };
  const reason = persistenceError ?? ownerError;
  return reason ? { kind: "write", reason } : null;
}

/** The block's cause in one short phrase. */
export function pageSaveBlockReason(block: PageSaveBlock) {
  switch (block.kind) {
    case "conflict":
      return m.page_source_conflict_title();
    case "write":
      return block.reason;
    case "access": {
      const { recovery } = block;
      if (recovery.planChanged) return m.page_leave_reason_plan_changed();
      if (recovery.readyToRetry) return m.page_leave_reason_ready();
      const blocker = recovery.primaryBlocker ?? recovery.blockers[0];
      if (!blocker) return m.page_save_reason_access();
      return m.page_leave_reason_access({
        repository: blocker.target.namedByPath
          ? blocker.target.displayPath
          : blocker.target.displayName,
        status: repositoryAccessPresentation(
          blocker.access,
        ).statusLabel.toLocaleLowerCase(),
      });
    }
  }
}
