import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CollectionToolbarActionButton } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

export function RoutineAutomaticConsentNotice({
  automaticError,
  loading,
  recoveryError,
  recoveryPending,
  readOnly = false,
  storageResetPending,
  onDismissReset,
  onRetry,
}: {
  automaticError: string | null;
  loading: boolean;
  recoveryError: string | null;
  recoveryPending: boolean;
  readOnly?: boolean;
  storageResetPending: boolean;
  onDismissReset(): void;
  onRetry(): void;
}) {
  if (!storageResetPending && !automaticError) return null;

  const triggerLabel = storageResetPending
    ? m.routines_storage_reset_trigger()
    : m.routines_automatic_authority_error_trigger();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <CollectionToolbarActionButton
          active
          icon={AlertTriangle}
          label={triggerLabel}
          aria-label={triggerLabel}
          data-routine-automatic-consent-notice
        />
      </DialogTrigger>
      <DialogContent data-routine-automatic-consent-notice-dialog>
        <RoutineAutomaticConsentNoticeContent
          automaticError={automaticError}
          loading={loading}
          recoveryError={recoveryError}
          recoveryPending={recoveryPending}
          readOnly={readOnly}
          storageResetPending={storageResetPending}
          onDismissReset={onDismissReset}
          onRetry={onRetry}
        />
      </DialogContent>
    </Dialog>
  );
}

export function RoutineAutomaticConsentNoticeContent({
  automaticError,
  loading,
  recoveryError,
  recoveryPending,
  readOnly = false,
  storageResetPending,
  onDismissReset,
  onRetry,
}: {
  automaticError: string | null;
  loading: boolean;
  recoveryError: string | null;
  recoveryPending: boolean;
  readOnly?: boolean;
  storageResetPending: boolean;
  onDismissReset(): void;
  onRetry(): void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {storageResetPending
            ? m.routines_storage_reset_title()
            : m.routines_automatic_authority_error_title()}
        </DialogTitle>
        <DialogDescription>
          {storageResetPending
            ? m.routines_storage_reset_description()
            : m.routines_automatic_authority_error_description()}
        </DialogDescription>
      </DialogHeader>
      {automaticError ? (
        <p className="text-sm text-destructive">{automaticError}</p>
      ) : null}
      {recoveryError ? (
        <p className="text-sm text-destructive">{recoveryError}</p>
      ) : null}
      <DialogFooter>
        {automaticError ? (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onRetry}
          >
            {m.routines_retry()}
          </Button>
        ) : null}
        {storageResetPending ? (
          <Button
            type="button"
            disabled={readOnly || recoveryPending}
            onClick={onDismissReset}
          >
            {recoveryPending
              ? m.routines_storage_reset_dismissing()
              : m.routines_storage_reset_dismiss()}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
