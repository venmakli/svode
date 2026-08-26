import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import { timezoneCityLabel } from "../model/routine-time-basis";
import type {
  RoutineRow,
  RoutineTimeBasis,
  RoutineTrigger,
} from "../model/types";

export function routineTimeBasisLabel(timeBasis: RoutineTimeBasis) {
  if (timeBasis.mode === "local") return m.routines_timezone_local();
  return `${m.routines_timezone_fixed()} · ${timezoneCityLabel(timeBasis.timezone)} (${timeBasis.timezone})`;
}

export function routineScheduleSummary(
  trigger: Extract<RoutineTrigger, { type: "schedule" }>,
) {
  return `${m.routines_trigger_schedule()} · ${trigger.cron} · ${routineTimeBasisLabel(trigger.timeBasis)}`;
}

export function routineNextRunCopy(row: RoutineRow) {
  if (!row.nextRunAt || row.definition?.trigger.type !== "schedule")
    return null;
  const { timeBasis } = row.definition.trigger;
  const date = new Date(row.nextRunAt);
  let value = row.nextRunAt;
  if (!Number.isNaN(date.getTime())) {
    try {
      value = new Intl.DateTimeFormat(getLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
        ...(timeBasis.mode === "fixed" ? { timeZone: timeBasis.timezone } : {}),
      }).format(date);
    } catch {
      value = row.nextRunAt;
    }
  }
  return {
    helper:
      timeBasis.mode === "local"
        ? m.routines_next_run_local_helper()
        : m.routines_next_run_fixed_helper({ timezone: timeBasis.timezone }),
    value,
  };
}
