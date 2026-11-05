import { AlertTriangle, LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CollectionActionState } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import { routineAgentActorId } from "../model/launch-refusal";
import type {
  RoutineLaunchRecoveryActions,
  RoutineLaunchRefusal,
  RoutineItem,
} from "../model/types";
import { RoutineLaunchRefusalNotice } from "./routine-launch-refusal";

/**
 * "Run now" of a Routine among the tools of its top bar, or "Open session"
 * while its run is active; "Open session" next to it once a run left one.
 * The run's pending and failed states are the owner's `runState`.
 */
export function RoutineRunTool({
  item,
  runState,
  onOpenSession,
  onRun,
}: {
  item: RoutineItem;
  runState: CollectionActionState;
  onOpenSession(item: RoutineItem): void;
  /** Runs the Routine; the owner keeps why a run failed in `runState`. */
  onRun(item: RoutineItem): Promise<void>;
}) {
  const manuallyRunnable = item.definition?.trigger.type !== "event";
  const active = item.lastRun?.active === true;
  // A launch refused before its session leaves no session to open.
  const lastSession =
    item.lastRun && !(item.lastRun.refusal && !item.lastRun.sourceSessionId)
      ? item.lastRun
      : null;
  const pending = runState.status === "pending";
  const disabled = pending || runState.status === "disabled";
  const disabledReason =
    runState.status === "disabled" ? runState.reason : undefined;

  if (!manuallyRunnable && item.definition && !item.lastRun) return null;

  return (
    <div className="flex items-center gap-1" data-routine-run-tool>
      {!active && lastSession ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenSession(item)}
        >
          {m.routines_open_session()}
        </Button>
      ) : null}
      {active ? (
        <Button type="button" size="sm" onClick={() => onOpenSession(item)}>
          {m.routines_open_session()}
        </Button>
      ) : manuallyRunnable || !item.definition ? (
        <WithDisabledReason reason={disabledReason}>
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (!disabled) void onRun(item).catch(() => undefined);
            }}
          >
            {pending ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {pending ? m.routines_starting() : m.routines_run_now()}
          </Button>
        </WithDisabledReason>
      ) : null}
    </div>
  );
}

/**
 * Why a disabled "Run now" is disabled, as a tooltip on hover. A disabled
 * button takes no pointer events, so the tooltip hangs on a wrapper around it.
 */
function WithDisabledReason({
  children,
  reason,
}: {
  children: ReactElement;
  reason: string | undefined;
}) {
  if (!reason) return children;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" data-routine-run-disabled-reason>
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Why the last manual run of the Routine failed, with the place a refused
 * launch is fixed; nothing while it did not fail.
 */
export function RoutineRunError({
  item,
  recovery = {},
  runRefusal = null,
  runState,
}: {
  item: RoutineItem;
  recovery?: RoutineLaunchRecoveryActions;
  /** Why the last manual run was refused before its first prompt. */
  runRefusal?: RoutineLaunchRefusal | null;
  runState: CollectionActionState;
}) {
  if (runState.status !== "error") return null;
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertDescription>
        {runRefusal ? (
          <RoutineLaunchRefusalNotice
            actorId={routineAgentActorId(item)}
            recovery={recovery}
            refusal={runRefusal}
          />
        ) : (
          runState.message
        )}
      </AlertDescription>
    </Alert>
  );
}
