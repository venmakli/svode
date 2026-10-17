import { useCallback, useState } from "react";
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
import { useSpaceActions } from "../hooks/use-space-actions";
import { useSpaceSidebarDelete } from "../hooks/use-space-sidebar-delete";
import type { DeleteSpaceTarget } from "../hooks/use-space-sidebar-dialog-state";
import { useSpaceStore } from "../model";

/** The confirmation of removing a Space from the project, its files kept. */
export function SpaceDeleteDialog({
  target,
  onClose,
}: {
  target: DeleteSpaceTarget | null;
  onClose: () => void;
}) {
  const activeRootPath = useSpaceStore((state) => state.activeRootPath);
  const { deleteSpace } = useSpaceActions();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const close = useCallback(() => {
    setDeleteFiles(false);
    onClose();
  }, [onClose]);
  const handleDeleteSpace = useSpaceSidebarDelete({
    activeRootPath,
    deleteFiles,
    deleteSpace,
    resetDeleteDialog: close,
  });

  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.space_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.space_delete_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-center gap-2 py-2">
          <Checkbox
            checked={deleteFiles}
            onCheckedChange={(checked) => setDeleteFiles(checked === true)}
          />
          <span className="text-sm text-destructive">
            {m.space_delete_files()}
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => target && handleDeleteSpace(target.id)}
          >
            {m.space_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
