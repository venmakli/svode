import { useEffect, useRef } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { usePageSurfaceSession } from "../hooks/page-surface-context";
import { PageSourceConflictRecovery } from "./page-source-conflict-recovery";

export function PageAccessRecovery({
  className,
  error,
  onRetry,
}: {
  className?: string;
  error?: string | null;
  onRetry?: () => Promise<void>;
}) {
  const session = usePageSurfaceSession();
  const { registerRecoveryElement } = session;
  const statusRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasVisibleRef = useRef(false);
  const conflict = session.sourceConflict;
  // A failure the Page session already presents (access recovery, busy
  // source, failed flush) is not repeated as the owner's own write error.
  const ownerError =
    session.recovery.open || session.persistenceError ? null : error;
  // The editor keeps Tab for indentation, so a recovery that appears takes
  // focus to stay reachable from the keyboard and returns it when resolved.
  const visible =
    (session.recovery.open &&
      session.recovery.pending?.placement === "inline") ||
    Boolean(session.persistenceError || ownerError || conflict);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      statusRef.current?.focus();
    } else if (!visible && wasVisibleRef.current) {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  if (!visible) return null;
  const discardButton = (size: "default" | "sm") => (
    <Button
      type="button"
      variant="destructive"
      size={size}
      onClick={session.requestDiscard}
    >
      {m.page_discard_changes()}
    </Button>
  );
  return (
    <div
      ref={(element) => {
        statusRef.current = element;
        registerRecoveryElement(element);
      }}
      className={cn("flex flex-col gap-2 outline-none", className)}
      tabIndex={-1}
    >
      {conflict ? <PageSourceConflictRecovery conflict={conflict} /> : null}
      <RepositoryAccessInlineRecovery recovery={session.recovery} />
      {session.recovery.open ? (
        <div className="flex flex-wrap justify-end gap-2">
          {discardButton("default")}
          <RepositoryAccessPrimaryButton recovery={session.recovery} />
        </div>
      ) : null}
      {session.persistenceError || ownerError ? (
        <Alert variant="destructive">
          <AlertTitle>{m.page_surface_save_error_title()}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{session.persistenceError ?? ownerError}</span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(onRetry) && session.readOnly}
                onClick={() =>
                  void (onRetry && !session.persistenceError
                    ? onRetry()
                        .then(() => session.prepareForNavigation())
                        .catch(() => undefined)
                    : session.retryPersistence())
                }
              >
                {m.page_surface_save_retry()}
              </Button>
              {discardButton("sm")}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
