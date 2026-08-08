import type { RoutineTrigger } from "./types";

export type RoutineSchedulePreset =
  | "daily"
  | "weekdays"
  | "weekly"
  | "advanced";

export interface RoutineScheduleEditorValue {
  preset: RoutineSchedulePreset;
  time: string;
  weekday: string;
}

const DEFAULT_TIME = "09:00";
const DEFAULT_WEEKDAY = "1";
const SIMPLE_SCHEDULE_PATTERN =
  /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|[0-7])$/;

export function routineScheduleEditorValue(
  cron: string,
): RoutineScheduleEditorValue {
  const match = SIMPLE_SCHEDULE_PATTERN.exec(cron.trim());
  if (!match) {
    return {
      preset: "advanced",
      time: DEFAULT_TIME,
      weekday: DEFAULT_WEEKDAY,
    };
  }

  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) {
    return {
      preset: "advanced",
      time: DEFAULT_TIME,
      weekday: DEFAULT_WEEKDAY,
    };
  }

  const day = match[3];
  return {
    preset: day === "*" ? "daily" : day === "1-5" ? "weekdays" : "weekly",
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday: day === "7" ? "0" : day === "*" || day === "1-5" ? "1" : day,
  };
}

export function changeRoutineSchedulePreset(
  trigger: Extract<RoutineTrigger, { type: "schedule" }>,
  preset: RoutineSchedulePreset,
): Extract<RoutineTrigger, { type: "schedule" }> {
  if (preset === "advanced") return trigger;
  const current = routineScheduleEditorValue(trigger.cron);
  return {
    ...trigger,
    cron: routineScheduleCron(preset, current.time, current.weekday),
  };
}

export function changeRoutineScheduleTime(
  trigger: Extract<RoutineTrigger, { type: "schedule" }>,
  time: string,
): Extract<RoutineTrigger, { type: "schedule" }> {
  const current = routineScheduleEditorValue(trigger.cron);
  if (current.preset === "advanced") return trigger;
  return {
    ...trigger,
    cron: routineScheduleCron(current.preset, time, current.weekday),
  };
}

export function changeRoutineScheduleWeekday(
  trigger: Extract<RoutineTrigger, { type: "schedule" }>,
  weekday: string,
): Extract<RoutineTrigger, { type: "schedule" }> {
  const current = routineScheduleEditorValue(trigger.cron);
  if (current.preset !== "weekly") return trigger;
  return {
    ...trigger,
    cron: routineScheduleCron("weekly", current.time, weekday),
  };
}

export function routineScheduleCron(
  preset: Exclude<RoutineSchedulePreset, "advanced">,
  time: string,
  weekday: string,
) {
  const parsed = parseTime(time);
  const day =
    preset === "daily" ? "*" : preset === "weekdays" ? "1-5" : weekday;
  return `${parsed.minute} ${parsed.hour} * * ${day}`;
}

function parseTime(time: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return { hour: 9, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 9, minute: 0 };
  return { hour, minute };
}
