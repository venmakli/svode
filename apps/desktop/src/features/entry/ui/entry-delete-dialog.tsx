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
import type { Entry } from "../model";
import * as m from "@/paraglide/messages.js";

export function EntryDeleteDialog({
  entry,
  onOpenChange,
  onDeleteEntry,
}: {
  entry: Entry | null;
  onOpenChange: (open: boolean) => void;
  onDeleteEntry: (entry: Entry) => void;
}) {
  return (
    <AlertDialog
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.space_delete()}</AlertDialogTitle>
          <AlertDialogDescription>
            {entry?.meta.title ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
          <AlertDialogAction onClick={() => entry && onDeleteEntry(entry)}>
            {m.space_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
