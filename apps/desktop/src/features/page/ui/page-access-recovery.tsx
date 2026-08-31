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

export function PageAccessRecovery({ className }: { className?: string }) {
  const session = usePageSurfaceSession();
  const statusRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasVisibleRef = useRef(false);
  const visible =
    (session.recovery.open &&
      session.recovery.pending?.placement === "inline") ||
    Boolean(session.persistenceError);

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
  return (
    <div
      ref={statusRef}
      className={cn("flex flex-col gap-2 outline-none", className)}
      tabIndex={-1}
    >
      <RepositoryAccessInlineRecovery recovery={session.recovery} />
      {session.recovery.open ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={session.dismissRecovery}
          >
            {m.git_access_preflight_cancel()}
          </Button>
          <RepositoryAccessPrimaryButton recovery={session.recovery} />
        </div>
      ) : null}
      {session.persistenceError ? (
        <Alert variant="destructive">
          <AlertTitle>{m.page_surface_save_error_title()}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{session.persistenceError}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void session.retryPersistence()}
            >
              {m.page_surface_save_retry()}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
