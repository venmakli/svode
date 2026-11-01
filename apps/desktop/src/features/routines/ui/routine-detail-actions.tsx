import { useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { CollectionActionState } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import {
  RoutineLaunchRefusedError,
  routineAgentActorId,
} from "../model/launch-refusal";
import type {
  RoutineLaunchRecoveryActions,
  RoutineLaunchRefusal,
  RoutineRow,
} from "../model/types";
import { RoutineLaunchRefusalNotice } from "./routine-launch-refusal";

export function RoutineDetailActions({
  recovery = {},
  row,
  runRefusal = null,
  runState,
  onOpenSession,
  onRun,
}: {
  recovery?: RoutineLaunchRecoveryActions;
  row: RoutineRow;
  /** Why the last manual run was refused before its first prompt. */
  runRefusal?: RoutineLaunchRefusal | null;
  runState: CollectionActionState;
  onOpenSession(row: RoutineRow): void;
  onRun(row: RoutineRow): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    message: string;
    refusal: RoutineLaunchRefusal | null;
  } | null>(
    runState.status === "error"
      ? { message: runState.message, refusal: runRefusal }
      : null,
  );
  const manuallyRunnable = row.definition?.trigger.type !== "event";
  const active = row.lastRun?.active === true;
  // A launch refused before its session leaves no session to open.
  const lastSession =
    row.lastRun && !(row.lastRun.refusal && !row.lastRun.sourceSessionId)
      ? row.lastRun
      : null;
  const disabled = pending || runState.status === "disabled";
  const disabledReason =
    runState.status === "disabled" ? runState.reason : undefined;

  if (!manuallyRunnable && row.definition && !row.lastRun) return null;

  async function run() {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await onRun(row);
    } catch (cause) {
      setError({
        message:
          cause instanceof Error && cause.message
            ? cause.message
            : m.routines_dispatch_failed(),
        refusal:
          cause instanceof RoutineLaunchRefusedError ? cause.refusal : null,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            {error.refusal ? (
              <RoutineLaunchRefusalNotice
                actorId={routineAgentActorId(row)}
                recovery={recovery}
                refusal={error.refusal}
              />
            ) : (
              error.message
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex w-full justify-end gap-2">
        {!active && lastSession ? (
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
        ) : manuallyRunnable || !row.definition ? (
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
