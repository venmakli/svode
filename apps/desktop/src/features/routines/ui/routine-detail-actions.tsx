import { useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SystemCollectionActionState } from "@/features/collection/system";
import * as m from "@/paraglide/messages.js";

import type { RoutineRow } from "../model/types";

export function RoutineDetailActions({
  row,
  runState,
  onOpenSession,
  onRun,
}: {
  row: RoutineRow;
  runState: SystemCollectionActionState;
  onOpenSession(row: RoutineRow): void;
  onRun(row: RoutineRow): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(
    runState.status === "error" ? runState.message : null,
  );
  const manual = row.definition?.trigger.type === "manual";
  const active = row.lastRun?.active === true;
  const disabled = pending || runState.status === "disabled";
  const disabledReason =
    runState.status === "disabled" ? runState.reason : undefined;

  if (!manual && row.definition && !row.lastRun) return null;

  async function run() {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await onRun(row);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : m.routines_dispatch_failed(),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex w-full justify-end gap-2">
        {!active && row.lastRun ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenSession(row)}
          >
            {m.routines_open_session()}
          </Button>
        ) : null}
        {active ? (
          <Button type="button" onClick={() => onOpenSession(row)}>
            {m.routines_open_session()}
          </Button>
        ) : manual || !row.definition ? (
          <Button
            type="button"
            disabled={disabled}
            title={disabledReason}
            onClick={() => void run()}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending ? m.routines_starting() : m.routines_run_now()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
