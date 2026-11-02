import { Badge } from "@/components/ui/badge";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import { routineAgentActorId } from "../model/launch-refusal";
import type { RoutineItem, RoutineLaunchRecoveryActions } from "../model/types";
import { RoutineLaunchRefusalNotice } from "./routine-launch-refusal";
import {
  routineNextRunCopy,
  routineScheduleSummary,
} from "./routine-schedule-copy";

/** "Trigger" on the Routine's screen: the schedule or the event it waits for. */
export function RoutineTriggerDetail({
  item,
  label,
}: {
  item: RoutineItem;
  label: string;
}) {
  const trigger = item.definition?.trigger;
  if (!trigger) return null;
  if (trigger.type === "schedule")
    return <>{routineScheduleSummary(trigger)}</>;
  if (trigger.type === "event") {
    return (
      <span className="break-words [overflow-wrap:anywhere]">
        {label} · <code className="font-mono text-xs">{trigger.event}</code>
      </span>
    );
  }
  return <>{label}</>;
}

/** "Last run": when, where, and why its launch was refused. */
export function RoutineLastRunDetail({
  item,
  recovery,
}: {
  item: RoutineItem;
  recovery: RoutineLaunchRecoveryActions;
}) {
  if (!item.lastRunAt) return null;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <time dateTime={item.lastRunAt}>
          {formatRoutineRunDate(item.lastRunAt)}
        </time>
        {item.lastRunOrigin === "remote" ? (
          <Badge variant="outline">{m.routines_last_run_remote()}</Badge>
        ) : null}
      </span>
      {item.lastRun?.refusal ? (
        <span className="flex text-destructive">
          <RoutineLaunchRefusalNotice
            actorId={routineAgentActorId(item)}
            recovery={recovery}
            refusal={item.lastRun.refusal}
          />
        </span>
      ) : null}
    </span>
  );
}

/** "Next run": when the schedule runs the Routine next. */
export function RoutineNextRunDetail({ item }: { item: RoutineItem }) {
  const copy = routineNextRunCopy(item);
  if (!copy) return null;
  return <time dateTime={item.nextRunAt ?? undefined}>{copy}</time>;
}

function formatRoutineRunDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
