import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

/** "Cancel sync" of the Git sync Dialog footer with its confirmation. */
export function GitSyncAbortButton({
  aborting,
  disabled,
  onConfirm,
}: {
  aborting: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          className="w-full sm:w-auto"
          disabled={disabled || aborting}
          aria-busy={aborting}
          data-git-sync-abort
        >
          {aborting && (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          )}
          {m.git_sync_abort_action()}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.git_sync_abort_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.git_sync_abort_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.git_sync_abort_back()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {m.git_sync_abort_action()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
