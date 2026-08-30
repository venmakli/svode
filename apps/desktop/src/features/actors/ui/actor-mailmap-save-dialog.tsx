import { AlertTriangle, LoaderCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import type { ActorMailmapSaveReview } from "../model/mailmap-save";

export function ActorMailmapSaveDialog({
  failure,
  pending,
  review,
  readOnly = false,
  onClose,
  onConfirm,
}: {
  failure: string | null;
  pending: boolean;
  review: ActorMailmapSaveReview | null;
  readOnly?: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  const includesRootPointer = Boolean(review?.rootPointerFingerprint);
  return (
    <AlertDialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent data-actors-mailmap-save-dialog>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangle />
          </AlertDialogMedia>
          <AlertDialogTitle>{m.actors_mailmap_save_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {includesRootPointer
              ? m.actors_mailmap_save_submodule_description()
              : m.actors_mailmap_save_description()}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <p className="text-sm text-muted-foreground">
          {m.actors_mailmap_save_warning()}
        </p>
        {failure ? (
          <p className="text-sm text-destructive" role="alert">
            {failure}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {m.actors_mailmap_save_cancel()}
          </AlertDialogCancel>
          <Button
            type="button"
            disabled={pending || readOnly}
            onClick={onConfirm}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending
              ? m.actors_mailmap_save_saving()
              : includesRootPointer
                ? m.actors_mailmap_save_submodule_confirm()
                : m.actors_mailmap_save_confirm()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
