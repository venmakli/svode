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

/**
 * "Cancel sync" of the Git sync Dialog footer with its confirmation; `copy`
 * gives «Отменить <операцию>» at an operation stop.
 */
export function GitSyncAbortButton({
  aborting,
  disabled,
  onConfirm,
  copy,
}: {
  aborting: boolean;
  disabled: boolean;
  onConfirm: () => void;
  copy?: { action: string; title: string; description: string };
}) {
  const [confirming, setConfirming] = useState(false);
  const { action, title, description } = copy ?? {
    action: m.git_sync_abort_action(),
    title: m.git_sync_abort_title(),
    description: m.git_sync_abort_description(),
  };
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
          {action}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.git_sync_abort_back()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
