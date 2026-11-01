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
import type { GitAbortCopy } from "./git-sync-stop-copy";

/**
 * "Cancel sync" of the Git sync Dialog footer with its confirmation; `copy`
 * gives «Отменить <операцию>» at an operation stop. The confirmation keeps
 * what it showed when it opened: the commits it lists and `expectedHead`,
 * the HEAD they are for, which the confirmed cancellation names.
 */
export function GitSyncAbortButton({
  aborting,
  disabled,
  onConfirm,
  copy,
  expectedHead = null,
}: {
  aborting: boolean;
  disabled: boolean;
  onConfirm: (expectedHead: string | null) => void;
  copy?: GitAbortCopy;
  expectedHead?: string | null;
}) {
  const current = {
    copy: copy ?? {
      action: m.git_sync_abort_action(),
      title: m.git_sync_abort_title(),
      description: m.git_sync_abort_description(),
    },
    expectedHead,
  };
  const [confirming, setConfirming] = useState(false);
  const [shown, setShown] = useState(current);
  const { action, title, description, dropped } = shown.copy;
  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(open) => {
        if (open) setShown(current);
        setConfirming(open);
      }}
    >
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
          {current.copy.action}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {dropped ? (
            <AlertDialogDescription asChild>
              <div className="flex min-w-0 flex-col gap-2">
                <p>{description}</p>
                <div
                  className="flex min-w-0 flex-col gap-1"
                  data-git-operation-abort-commits
                >
                  <p>{dropped.summary}</p>
                  <ul className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/50 p-3 text-left text-xs">
                    {dropped.titles.map((commitTitle, index) => (
                      <li key={index} className="break-words">
                        {commitTitle}
                      </li>
                    ))}
                    {dropped.more && <li>{dropped.more}</li>}
                  </ul>
                </div>
              </div>
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.git_sync_abort_back()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onConfirm(shown.expectedHead)}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
