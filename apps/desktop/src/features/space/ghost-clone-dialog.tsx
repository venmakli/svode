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

interface GhostCloneDialogProps {
  open: boolean;
  spaceName: string;
  cloning?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function GhostCloneDialog({
  open,
  spaceName,
  cloning = false,
  onOpenChange,
  onConfirm,
}: GhostCloneDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.doc_link_clone_missing_title()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.doc_link_clone_missing_description({ name: spaceName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cloning}>
            {m.doc_link_clone_missing_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction disabled={cloning} onClick={onConfirm}>
            {m.doc_link_clone_missing_action()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
