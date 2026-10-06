import { useState } from "react";
import * as m from "@/paraglide/messages.js";
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
import { Checkbox } from "@/components/ui/checkbox";

interface RemoveProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (deleteFiles: boolean) => void;
}

/** Confirms removing a project from the list, optionally with its files. */
export function RemoveProjectDialog({
  open,
  onOpenChange,
  onRemove,
}: RemoveProjectDialogProps) {
  const [deleteFiles, setDeleteFiles] = useState(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDeleteFiles(false);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.project_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.project_delete_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-center gap-2 py-2">
          <Checkbox
            checked={deleteFiles}
            onCheckedChange={(checked) => setDeleteFiles(checked === true)}
          />
          <span className="text-sm text-destructive">
            {m.project_delete_files()}
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onRemove(deleteFiles)}
          >
            {m.project_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
