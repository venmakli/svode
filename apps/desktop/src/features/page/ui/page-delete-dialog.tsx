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
import type { Page } from "../model";
import * as m from "@/paraglide/messages.js";

export function PageDeleteDialog({
  page,
  onOpenChange,
  onDeletePage,
}: {
  page: Page | null;
  onOpenChange: (open: boolean) => void;
  onDeletePage: (page: Page) => void;
}) {
  return (
    <AlertDialog
      open={Boolean(page)}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.space_delete()}</AlertDialogTitle>
          <AlertDialogDescription>
            {page?.meta.title ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
          <AlertDialogAction onClick={() => page && onDeletePage(page)}>
            {m.space_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
