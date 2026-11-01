import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import { timezoneDisplayLabel } from "../model/routine-time-basis";
import type {
  RoutineItem,
  RoutineTimeBasis,
  RoutineTrigger,
} from "../model/types";

export function routineTimeBasisLabel(timeBasis: RoutineTimeBasis) {
  if (timeBasis.mode === "local") return m.routines_timezone_local();
  return timezoneDisplayLabel(timeBasis.timezone, getLocale());
}

export function routineScheduleSummary(
  trigger: Extract<RoutineTrigger, { type: "schedule" }>,
) {
  return `${m.routines_trigger_schedule()} · ${trigger.cron}`;
}

export function routineNextRunCopy(item: RoutineItem) {
  if (!item.nextRunAt || item.definition?.trigger.type !== "schedule")
    return null;
  const { timeBasis } = item.definition.trigger;
  const date = new Date(item.nextRunAt);
  let value = item.nextRunAt;
  if (!Number.isNaN(date.getTime())) {
    try {
      value = new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timeBasis.mode === "fixed" ? { timeZone: timeBasis.timezone } : {}),
      }).format(date);
    } catch {
      value = item.nextRunAt;
    }
  }
  return value;
}
