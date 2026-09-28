import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  repositoryAccessPresentation,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type { PageSourceConflict } from "../model/source-conflict";

/** A question about the unsaved drafts of a Page whose save is blocked. */
export interface PageDiscardConfirmation {
  /** `leave`: the user navigates away; `discard`: asked from the recovery. */
  kind: "leave" | "discard";
  resolve: (discarded: boolean) => void;
}

export function PageDiscardDialog({
  confirmation,
  persistenceError,
  recovery,
  sourceConflict,
  onResolve,
  onKeepFocus,
}: {
  confirmation: PageDiscardConfirmation | null;
  persistenceError: string | null;
  recovery: RepositoryAccessPreflightController;
  sourceConflict: PageSourceConflict | null;
  onResolve: (discard: boolean) => void;
  onKeepFocus: () => void;
}) {
  // Keeps the copy of the closing question during its exit animation.
  const [shown, setShown] = useState(confirmation);
  if (confirmation && confirmation !== shown) setShown(confirmation);
  const keptRef = useRef(false);
  const leave = shown?.kind === "leave";

  return (
    <AlertDialog
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (open) return;
        keptRef.current = true;
        onResolve(false);
      }}
    >
      <AlertDialogContent
        data-page-discard-confirmation={shown?.kind}
        onCloseAutoFocus={(event) => {
          const kept = keptRef.current;
          keptRef.current = false;
          if (!leave || !kept) return;
          // Staying keeps the blocked draft: back to where it is recovered.
          event.preventDefault();
          onKeepFocus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {leave ? m.page_leave_title() : m.page_discard_title()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {leave
              ? pageSaveBlockReason({
                  persistenceError,
                  recovery,
                  sourceConflict,
                })
              : m.page_discard_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {leave ? m.page_leave_stay() : m.page_discard_keep()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              // The session closes the question once it is resolved.
              event.preventDefault();
              onResolve(true);
            }}
          >
            {leave ? m.page_leave_discard() : m.page_discard_changes()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function pageSaveBlockReason({
  persistenceError,
  recovery,
  sourceConflict,
}: {
  persistenceError: string | null;
  recovery: RepositoryAccessPreflightController;
  sourceConflict: PageSourceConflict | null;
}) {
  if (sourceConflict) return m.page_source_conflict_title();
  if (recovery.open) {
    if (recovery.planChanged) return m.page_leave_reason_plan_changed();
    if (recovery.readyToRetry) return m.page_leave_reason_ready();
    const blocker = recovery.primaryBlocker ?? recovery.blockers[0];
    if (blocker)
      return m.page_leave_reason_access({
        repository: blocker.target.displayName,
        status: repositoryAccessPresentation(
          blocker.access,
        ).statusLabel.toLocaleLowerCase(),
      });
  }
  return persistenceError ?? m.page_surface_save_error();
}
