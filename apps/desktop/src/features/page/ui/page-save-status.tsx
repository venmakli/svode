import { TriangleAlert } from "lucide-react";
import { flushSync } from "react-dom";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import { usePageSurfaceSession } from "../hooks/page-surface-context";
import { pageSaveBlock, pageSaveBlockReason } from "../lib/save-block";
import { PageSaveRecoveryDialog } from "./page-save-recovery-dialog";

/**
 * The save state in the title row: while the session holds a blocked draft,
 * a "Not saved" indicator replaces `children` and opens the recovery Dialog.
 * A commit refused for a source conflict opens it too, saying so.
 */
export function PageSaveStatus({
  children,
  error,
  onRetry,
  title,
}: {
  children?: ReactNode;
  /** A failed write of the detail owner the session does not present itself. */
  error?: string | null;
  onRetry?: () => Promise<void>;
  /** The Page as the discard confirmation names it. */
  title: string;
}) {
  const session = usePageSurfaceSession();
  const {
    commitRefusalRequest,
    persistenceError,
    recovery,
    registerRecoveryElement,
    sourceConflict,
  } = session;
  const block = useMemo(
    () =>
      pageSaveBlock({
        ownerError: error,
        persistenceError,
        recovery,
        sourceConflict,
      }),
    [error, persistenceError, recovery, sourceConflict],
  );
  const reason = block ? pageSaveBlockReason(block) : null;
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState({
    request: commitRefusalRequest,
    shown: false,
  });
  if (refusal.request !== commitRefusalRequest) {
    const shown = block?.kind === "conflict";
    setRefusal({ request: commitRefusalRequest, shown });
    if (shown) setOpen(true);
  }
  // A resolved block closes its Dialog; the next block never opens it.
  if (open && !block) setOpen(false);
  const indicatorRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  const resumeRef = useRef<HTMLElement | null>(null);
  const handoffRef = useRef(false);
  const blocked = block !== null;
  // The Dialog may close with the block itself: its focus return reads the latest state.
  const blockedRef = useRef(blocked);

  useEffect(() => {
    blockedRef.current = blocked;
    if (!blocked) return;
    // Where the user worked when saving stopped is where a recovery returns.
    const active = document.activeElement;
    resumeRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [blocked]);

  const retryWrite = () =>
    onRetry && !persistenceError
      ? onRetry()
          .then(() => session.prepareForNavigation())
          .then(() => undefined)
          .catch(() => undefined)
      : session.retryPersistence();

  return (
    <>
      {block ? (
        <Button
          ref={(element: HTMLButtonElement | null) => {
            indicatorRef.current = element;
            registerRecoveryElement(element);
          }}
          type="button"
          variant="ghost"
          size="xs"
          className="-mr-1.5 h-5 px-1.5 text-warning hover:text-warning"
          aria-haspopup="dialog"
          aria-label={m.page_save_blocked_label({ reason: reason ?? "" })}
          data-page-save-block={block.kind}
          onClick={() => {
            setRefusal((current) => ({ ...current, shown: false }));
            setOpen(true);
          }}
        >
          <TriangleAlert data-icon="inline-start" />
          {m.page_save_blocked()}
        </Button>
      ) : (
        children
      )}
      <span ref={statusRef} className="sr-only" role="status">
        {reason ? m.page_save_blocked_label({ reason }) : ""}
      </span>
      <PageSaveRecoveryDialog
        block={block}
        commitRefused={refusal.shown}
        open={open && blocked}
        retryDisabled={Boolean(onRetry) && session.readOnly}
        title={title}
        onClose={() => {
          setRefusal((current) => ({ ...current, shown: false }));
          setOpen(false);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (handoffRef.current) {
            handoffRef.current = false;
            return;
          }
          if (blockedRef.current) indicatorRef.current?.focus();
          else focusPageContent(resumeRef.current, statusRef.current);
        }}
        onDiscard={session.discard}
        onLeaveForSettings={() => {
          // Git settings return focus to the indicator once they close.
          handoffRef.current = true;
          flushSync(() => setOpen(false));
          indicatorRef.current?.focus();
        }}
        onRetryWrite={retryWrite}
      />
    </>
  );
}

/** Back to where the user worked, or to the title of this Page. */
function focusPageContent(
  resume: HTMLElement | null,
  anchor: HTMLElement | null,
) {
  if (resume?.isConnected) {
    resume.focus();
    if (document.activeElement === resume) return;
  }
  anchor
    ?.closest("[data-page-detail-header]")
    ?.querySelector<HTMLElement>("input")
    ?.focus();
}
