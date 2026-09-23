import { FileWarning, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import type { PageSourceConflict } from "../model/source-conflict";

export function PageSourceConflictRecovery({
  conflict,
}: {
  conflict: PageSourceConflict;
}) {
  const busy = conflict.status === "reading" || conflict.pending !== null;
  const note = conflictNote(conflict);
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      aria-busy={busy}
      data-page-source-conflict={conflict.status}
    >
      <Alert>
        <FileWarning />
        <AlertTitle>{m.page_source_conflict_title()}</AlertTitle>
        <AlertDescription>
          <p>
            {conflict.status === "reading"
              ? m.page_source_conflict_reading()
              : m.page_source_conflict_description()}
          </p>
          {note ? (
            <p className="text-destructive" data-page-source-conflict-note>
              {note}
            </p>
          ) : null}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap justify-end gap-2">
        {conflict.status === "read_failed" ? (
          <Button type="button" onClick={conflict.retryRead}>
            {m.page_source_conflict_retry_read()}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              data-page-source-conflict-load
              onClick={conflict.loadFile}
            >
              {conflict.pending === "load" ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {m.page_source_conflict_load()}
            </Button>
            <Button
              type="button"
              disabled={busy}
              data-page-source-conflict-write
              onClick={conflict.writeDraft}
            >
              {conflict.pending === "write" ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {m.page_source_conflict_write()}
            </Button>
          </>
        )}
      </div>
    </div>
  );
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
