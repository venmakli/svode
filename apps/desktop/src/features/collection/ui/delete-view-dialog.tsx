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

export function DeleteViewDialog({
  open,
  onOpenChange,
  onDeleteView,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleteView: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
  );
}
