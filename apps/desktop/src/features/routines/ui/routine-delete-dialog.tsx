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
} from "@/components/ui/alert-dialog";
import * as m from "@/paraglide/messages.js";

import type { RoutineRow } from "../model/types";

export function RoutineDeleteDialog({
  error,
  pending,
  routine,
  onClose,
  onConfirm,
}: {
  error: string | null;
  pending: boolean;
  routine: RoutineRow | null;
  onClose(): void;
  onConfirm(): void;
}) {
  if (!routine) return null;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.routines_delete_title({ title: routine.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.routines_delete_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onClose}>
            {m.routines_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending ? m.routines_deleting() : m.routines_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
