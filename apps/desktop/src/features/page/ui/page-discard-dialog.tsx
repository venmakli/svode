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

/** The question whether to leave a Page whose save is blocked. */
export interface PageDiscardConfirmation {
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
        data-page-discard-confirmation={shown ? "leave" : undefined}
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
          <AlertDialogTitle>{m.page_leave_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {block ? pageSaveBlockReason(block) : m.page_surface_save_error()}
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
            {m.page_leave_discard()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
