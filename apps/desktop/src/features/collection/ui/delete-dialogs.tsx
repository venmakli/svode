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
import type { Entry } from "@/features/editor/types";
import * as m from "@/paraglide/messages.js";

export function DeleteDialogs({
  viewOpen,
  entry,
  onViewOpenChange,
  onEntryOpenChange,
  onDeleteView,
  onDeleteEntry,
}: {
  viewOpen: boolean;
  entry: Entry | null;
  onViewOpenChange: (open: boolean) => void;
  onEntryOpenChange: (open: boolean) => void;
  onDeleteView: () => void;
  onDeleteEntry: (entry: Entry) => void;
}) {
  return (
    <>
      <AlertDialog open={viewOpen} onOpenChange={onViewOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.collection_delete_view_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.collection_delete_view_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction onClick={onDeleteView}>
              {m.space_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(entry)}
        onOpenChange={(open) => {
          if (!open) onEntryOpenChange(false);
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
    </>
  );
}
