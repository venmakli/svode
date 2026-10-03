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

/**
 * Removing a custom agent names what goes and what stays: Svode forgets
 * the command, the agent keeps its sessions and configuration.
 */
export function CustomAgentRemoveDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-custom-agent-remove>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.settings_agents_custom_remove_title({ agent: name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.settings_agents_custom_remove_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {m.settings_agents_custom_cancel()}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {m.settings_agents_custom_remove_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
