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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

/**
 * An action on a whole conflicted file; one that discards my version asks
 * first with a confirmation that names what is lost (1.F, item 5).
 */
export function ConflictResolveButton({
  label,
  confirm,
  disabled = false,
  title,
  onRun,
  ...data
}: {
  label: string;
  confirm?: { title: string; description: string };
  disabled?: boolean;
  /** Why the action is unavailable. */
  title?: string;
  onRun: () => void;
} & Record<`data-${string}`, string>) {
  const [open, setOpen] = useState(false);
  const button = (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      title={title}
      onClick={confirm ? undefined : onRun}
      {...data}
    >
      {label}
    </Button>
  );
  if (!confirm) return button;
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.changes_conflict_back()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onRun}>
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
