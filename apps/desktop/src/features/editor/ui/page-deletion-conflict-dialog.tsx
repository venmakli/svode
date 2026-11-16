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

import { usePageDeletionConflictChoice } from "../hooks/use-page-deletion-conflict-choice";

/**
 * Asks whether to keep the open Page with its edits or delete it while one
 * side edited it and the other deleted it (DF-354 R3, UX/UI contract).
 */
export function PageDeletionConflictDialog(
  props: Parameters<typeof usePageDeletionConflictChoice>[0],
) {
  const { open, deletedBy, pending, later, choose } =
    usePageDeletionConflictChoice(props);
  const { title } = props;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) later();
      }}
    >
      <AlertDialogContent
        data-page-deletion-conflict={deletedBy ?? undefined}
        aria-busy={pending}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deletedBy === "ours"
              ? m.page_deletion_conflict_ours_deleted_title({ title })
              : m.page_deletion_conflict_theirs_deleted_title({ title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deletedBy === "ours"
              ? m.page_deletion_conflict_ours_deleted_description()
              : m.page_deletion_conflict_theirs_deleted_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {m.page_deletion_conflict_later()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            data-page-deletion-conflict-choice="delete"
            onClick={(event) => {
              // The question closes once the choice is made.
              event.preventDefault();
              void choose("delete");
            }}
          >
            {m.changes_conflict_delete()}
          </AlertDialogAction>
          <AlertDialogAction
            disabled={pending}
            data-page-deletion-conflict-choice="keep"
            onClick={(event) => {
              event.preventDefault();
              void choose("keep");
            }}
          >
            {m.changes_conflict_keep_edited()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
