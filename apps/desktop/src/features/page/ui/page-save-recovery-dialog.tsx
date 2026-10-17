import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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
  RepositoryAccessBlockerItems,
  repositoryAccessPrimaryActionLabel,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import { pageSaveBlockReason, type PageSaveBlock } from "../lib/save-block";
import type { PageSourceConflict } from "../model/source-conflict";

/**
 * The recovery of a blocked Page save, opened from its indicator: the cause,
 * the way to save again and the explicit discard, asked in place.
 */
export function PageSaveRecoveryDialog({
  block,
  open,
  retryDisabled,
  onClose,
  onCloseAutoFocus,
  onDiscard,
  onLeaveForSettings,
  onRetryWrite,
  title,
}: {
  block: PageSaveBlock | null;
  open: boolean;
  retryDisabled: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  onDiscard: () => Promise<boolean>;
  /** Closes the Dialog so the Git settings it opens next take over. */
  onLeaveForSettings: () => void;
  onRetryWrite: () => Promise<void>;
  title: string;
}) {
  // Keeps the content of the resolved block during the exit animation.
  const [shown, setShown] = useState(block);
  if (block && block !== shown) setShown(block);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<"retry" | "discard" | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) focusDefault(contentRef.current);
  }, [confirming, open]);

  const close = () => {
    setConfirming(false);
    onClose();
  };
  const run = (kind: "retry" | "discard", action: () => Promise<unknown>) => {
    setPending(kind);
    void action().finally(() => setPending(null));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        ref={contentRef}
        className="sm:max-w-md"
        showCloseButton={false}
        data-page-save-recovery={shown?.kind}
        data-page-save-step={confirming ? "discard" : "recovery"}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusDefault(contentRef.current);
        }}
        onCloseAutoFocus={(event) => {
          setConfirming(false);
          onCloseAutoFocus(event);
        }}
      >
        {!shown ? null : confirming ? (
          <>
            <DialogHeader>
              <DialogTitle>{m.page_discard_title({ title })}</DialogTitle>
              <DialogDescription>
                {m.page_discard_description()}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-page-save-default
                onClick={() => setConfirming(false)}
              >
                {m.page_discard_keep()}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending !== null}
                onClick={() =>
                  run("discard", async () => {
                    if (!(await onDiscard())) setConfirming(false);
                  })
                }
              >
                <PendingIcon pending={pending === "discard"} />
                {m.page_discard_changes()}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <PageSaveRecoveryContent
            block={shown}
            pending={pending}
            retryDisabled={retryDisabled}
            onConfirmDiscard={() => setConfirming(true)}
            onLeaveForSettings={() => {
              setConfirming(false);
              onLeaveForSettings();
            }}
            onRetryWrite={() => run("retry", onRetryWrite)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PageSaveRecoveryContent({
  block,
  pending,
  retryDisabled,
  onConfirmDiscard,
  onLeaveForSettings,
  onRetryWrite,
}: {
  block: PageSaveBlock;
  pending: "retry" | "discard" | null;
  retryDisabled: boolean;
  onConfirmDiscard: () => void;
  onLeaveForSettings: () => void;
  onRetryWrite: () => void;
}) {
  const discard = (
    <Button type="button" variant="destructive" onClick={onConfirmDiscard}>
      {m.page_discard_changes()}
    </Button>
  );
  let description: ReactNode;
  let body: ReactNode = null;
  let destructive: ReactNode = discard;
  let primary: ReactNode;

  if (block.kind === "conflict") {
    const { conflict } = block;
    const busy = conflict.status === "reading" || conflict.pending !== null;
    const note = conflictNote(conflict);
    description =
      conflict.status === "reading"
        ? m.page_source_conflict_reading()
        : m.page_source_conflict_title();
    body = (
      <div
        className="flex flex-col gap-1 text-sm text-muted-foreground"
        aria-busy={busy}
        data-page-source-conflict={conflict.status}
      >
        <p>{m.page_source_conflict_description()}</p>
        {note ? (
          <p className="text-destructive" data-page-source-conflict-note>
            {note}
          </p>
        ) : null}
      </div>
    );
    if (conflict.status === "read_failed") {
      destructive = null;
      primary = (
        <Button
          type="button"
          data-page-save-default
          onClick={conflict.retryRead}
        >
          {m.page_source_conflict_retry_read()}
        </Button>
      );
    } else {
      // Loading the file version is the discard of a conflict.
      destructive = (
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          data-page-source-conflict-load
          onClick={conflict.loadFile}
        >
          <PendingIcon pending={conflict.pending === "load"} />
          {m.page_source_conflict_load()}
        </Button>
      );
      primary = (
        <Button
          type="button"
          disabled={busy}
          data-page-save-default
          data-page-source-conflict-write
          onClick={conflict.writeDraft}
        >
          <PendingIcon pending={conflict.pending === "write"} />
          {m.page_source_conflict_write()}
        </Button>
      );
    }
  } else if (block.kind === "access") {
    const { recovery } = block;
    const retry = recovery.readyToRetry || recovery.planChanged;
    const label = retry
      ? m.page_surface_save_retry()
      : repositoryAccessPrimaryActionLabel(recovery);
    description = retry
      ? pageSaveBlockReason(block)
      : m.page_save_reason_access();
    body = (
      <RepositoryAccessBlockerItems
        recovery={recovery}
        onOpenSettings={onLeaveForSettings}
      />
    );
    primary = label ? (
      <Button
        type="button"
        disabled={recovery.busy}
        data-page-save-default
        onClick={() => {
          if (!retry && recovery.primaryOpensSettings) onLeaveForSettings();
          recovery.runPrimaryAction();
        }}
      >
        <PendingIcon pending={recovery.busy} />
        {label}
      </Button>
    ) : null;
  } else {
    description = block.reason;
    primary = (
      <Button
        type="button"
        disabled={retryDisabled || pending === "retry"}
        data-page-save-default
        onClick={onRetryWrite}
      >
        <PendingIcon pending={pending === "retry"} />
        {m.page_surface_save_retry()}
      </Button>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{m.page_save_dialog_title()}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {body}
      <DialogFooter className="sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row">{destructive}</div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <DialogClose asChild>
            <Button type="button" variant="outline" data-page-save-close>
              {m.page_save_dialog_close()}
            </Button>
          </DialogClose>
          {primary}
        </div>
      </DialogFooter>
    </>
  );
}

function PendingIcon({ pending }: { pending: boolean }) {
  return pending ? (
    <LoaderCircle data-icon="inline-start" className="animate-spin" />
  ) : null;
}

/** The default action of the current step, or "Close" while it is disabled. */
function focusDefault(content: HTMLElement | null) {
  const target =
    content?.querySelector<HTMLElement>(
      "button[data-page-save-default]:not(:disabled)",
    ) ?? content?.querySelector<HTMLElement>("[data-page-save-close]");
  target?.focus();
}

function conflictNote(conflict: PageSourceConflict): string | null {
  if (conflict.status === "read_failed")
    return m.page_source_conflict_read_failed();
  switch (conflict.failure) {
    case "changed_again":
      return m.page_source_conflict_changed_again();
    case "write":
      return m.page_source_conflict_write_failed();
    case "load":
      return m.page_source_conflict_load_failed();
    default:
      return null;
  }
}
