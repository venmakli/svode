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
import type { RepositoryAccessPreflightController } from "@/features/git";
import * as m from "@/paraglide/messages.js";

import { pageSaveBlock, pageSaveBlockReason } from "../lib/save-block";
import type { PageSourceConflict } from "../model/source-conflict";

/** How the Page is left: a navigation away, or its Peek closed or expanded. */
export type PageLeaveAction = "leave" | "close" | "expand";

/** The question whether to leave a Page whose save is blocked. */
export interface PageDiscardConfirmation {
  action: PageLeaveAction;
  resolve: (discarded: boolean) => void;
  /** The Page as the question names it when asked. */
  title: string;
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
  const block = pageSaveBlock({ persistenceError, recovery, sourceConflict });

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
        data-page-discard-confirmation={shown?.action}
        onCloseAutoFocus={(event) => {
          const kept = keptRef.current;
          keptRef.current = false;
          if (!kept) return;
          // Staying keeps the blocked draft: back to where it is recovered.
          event.preventDefault();
          onKeepFocus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {shown ? leaveTitle(shown) : null}
          </AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-1">
            <span>
              {block ? pageSaveBlockReason(block) : m.page_surface_save_error()}
            </span>
            <span>{m.page_leave_description()}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.page_leave_stay()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              // The session closes the question once it is resolved.
              event.preventDefault();
              onResolve(true);
            }}
          >
            {shown ? leaveAction(shown.action) : null}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function leaveTitle({ action, title }: PageDiscardConfirmation) {
  switch (action) {
    case "close":
      return m.page_leave_close_title({ title });
    case "expand":
      return m.page_leave_expand_title({ title });
    case "leave":
      return m.page_leave_title({ title });
  }
}

function leaveAction(action: PageLeaveAction) {
  switch (action) {
    case "close":
      return m.page_leave_close_discard();
    case "expand":
      return m.page_leave_expand_discard();
    case "leave":
      return m.page_leave_discard();
  }
}
