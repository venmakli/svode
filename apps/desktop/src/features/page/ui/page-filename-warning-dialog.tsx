import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RepositoryAccessDenialItems } from "@/features/git";
import * as m from "@/paraglide/messages.js";

import { usePageFilenameWarningDetails } from "../model/filename-warning-details";

/**
 * The details of a deferred rename, opened from its warning toast: where the
 * file stayed, why, and how to retry it.
 */
export function PageFilenameWarningDialog() {
  const { details, open, close } = usePageFilenameWarningDetails();
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        data-page-filename-warning={details?.cause.kind}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        {details ? (
          <>
            <DialogHeader>
              <DialogTitle>{m.page_filename_rename_deferred()}</DialogTitle>
              <DialogDescription className="break-words">
                {details.path
                  ? m.page_filename_details_kept({ path: details.path })
                  : m.page_filename_details_kept_unknown_path()}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-2 text-sm">
              {details.cause.kind === "access" ? (
                <>
                  <p>{m.page_filename_details_access()}</p>
                  <RepositoryAccessDenialItems
                    blockers={details.cause.blockers}
                    onOpenSettings={close}
                  />
                </>
              ) : (
                <>
                  <p>{m.page_filename_details_dependencies()}</p>
                  <p
                    className="max-h-40 overflow-y-auto break-words text-muted-foreground"
                    data-page-filename-warning-message
                  >
                    {details.cause.message}
                  </p>
                </>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {m.page_filename_details_retry()}
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button ref={closeRef} type="button">
                  {m.page_filename_details_close()}
                </Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
