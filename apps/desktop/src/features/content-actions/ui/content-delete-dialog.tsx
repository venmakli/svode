import { useState } from "react";
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
import * as m from "@/paraglide/messages.js";
import {
  contentDeleteCopy,
  type ContentDeleteConfirmation,
} from "../model/delete-confirmation";

/**
 * The one confirmation of deleting content, the same on every surface: its
 * title names the type, its text the object and what goes with it, and it
 * lists the Pages that link to the object.
 */
export function ContentDeleteDialog<T>({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: ContentDeleteConfirmation<T> | null;
  onCancel: () => void;
  onConfirm: (value: T) => void;
}) {
  // The closing dialog keeps its text until it has faded out.
  const [shown, setShown] = useState(confirmation);
  if (confirmation && confirmation !== shown) setShown(confirmation);
  const current = confirmation ?? shown;
  const copy = current ? contentDeleteCopy(current.object, current.name) : null;
  const backlinks = current?.backlinks ?? [];

  return (
    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {copy?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {backlinks.length > 0 ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              {m.content_delete_backlinks()}
            </p>
            <ul
              data-content-delete-backlinks
              className="max-h-40 list-disc overflow-y-auto pl-5"
            >
              {backlinks.map((backlink) => (
                <li key={backlink.key} className="break-words">
                  {backlink.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (confirmation) onConfirm(confirmation.value);
            }}
          >
            {m.content_action_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
