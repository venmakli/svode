import { useEffect } from "react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  closeManagedTerminalSurface,
  ManagedTerminalSurface,
  subscribeManagedTerminalExit,
} from "@/features/terminal/session-surface";

/**
 * The agent's own sign-in command in a Svode terminal. The facts are read
 * again when the command exits and when the dialog closes.
 */
export function AgentSignInDialog({
  agent,
  ptyId,
  onSignedIn,
  onClose,
}: {
  agent: string;
  ptyId: string;
  onSignedIn: () => void;
  onClose: () => void;
}) {
  useEffect(
    () =>
      subscribeManagedTerminalExit((exited) => {
        if (exited === ptyId) onSignedIn();
      }),
    [onSignedIn, ptyId],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        void closeManagedTerminalSurface(ptyId).catch((error) =>
          console.warn("Failed to close the sign-in terminal:", error),
        );
        onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {m.settings_agents_sign_in_title({ agent })}
          </DialogTitle>
          <DialogDescription>
            {m.settings_agents_sign_in_description({ agent })}
          </DialogDescription>
        </DialogHeader>
        <div className="h-80 min-w-0 overflow-hidden rounded-md border">
          <ManagedTerminalSurface ptyId={ptyId} title={agent} />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button>{m.settings_agents_sign_in_done()}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
