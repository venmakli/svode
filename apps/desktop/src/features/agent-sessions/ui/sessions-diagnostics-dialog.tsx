import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CollectionToolbarActionButton } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

/**
 * Toolbar diagnostics of the Sessions collection: a partly unavailable source
 * or a failed refresh, with retry and the Providers settings.
 */
export function SessionsDiagnosticsDialog({
  problem,
  retrying,
  onRetry,
  onOpenSettings,
}: {
  problem: string | null;
  retrying: boolean;
  onRetry(): void;
  onOpenSettings(): void;
}) {
  if (!problem) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <CollectionToolbarActionButton
          active
          icon={AlertTriangle}
          label={problem}
          aria-label={problem}
          data-sessions-diagnostics
        />
      </DialogTrigger>
      <DialogContent data-sessions-diagnostics-dialog>
        <DialogHeader>
          <DialogTitle>{m.sessions_diagnostics_title()}</DialogTitle>
          <DialogDescription>{problem}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" onClick={onOpenSettings}>
              {m.sessions_action_open_settings()}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="outline"
            disabled={retrying}
            onClick={onRetry}
          >
            {m.sessions_action_retry()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
