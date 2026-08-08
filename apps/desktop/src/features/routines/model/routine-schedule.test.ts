import { expect, test } from "bun:test";

import {
  changeRoutineSchedulePreset,
  changeRoutineScheduleTime,
  changeRoutineScheduleWeekday,
  routineScheduleEditorValue,
} from "./routine-schedule";
import type { RoutineTrigger } from "./types";

const schedule: Extract<RoutineTrigger, { type: "schedule" }> = {
  cron: "0 9 * * 1-5",
  missedRuns: "skip",
  timezone: "Asia/Novosibirsk",
  type: "schedule",
};

test("recognizes the supported human schedule presets", () => {
  expect(routineScheduleEditorValue("30 8 * * *")).toEqual({
    preset: "daily",
    time: "08:30",
    weekday: "1",
  });
  expect(routineScheduleEditorValue("0 9 * * 1-5").preset).toBe("weekdays");
  expect(routineScheduleEditorValue("15 18 * * 7")).toEqual({
    preset: "weekly",
    time: "18:15",
    weekday: "0",
  });
  expect(routineScheduleEditorValue("*/15 * * * *").preset).toBe("advanced");
});

test("human schedule changes produce portable five-field cron", () => {
  const daily = changeRoutineSchedulePreset(schedule, "daily");
  expect(daily.cron).toBe("0 9 * * *");

  const timed = changeRoutineScheduleTime(daily, "14:35");
  expect(timed.cron).toBe("35 14 * * *");

  const weekly = changeRoutineSchedulePreset(timed, "weekly");
  expect(weekly.cron).toBe("35 14 * * 1");
  expect(changeRoutineScheduleWeekday(weekly, "5").cron).toBe("35 14 * * 5");
});

test("advanced cron remains unchanged when its mode is selected", () => {
  const advanced = { ...schedule, cron: "*/15 * * * *" };
  expect(changeRoutineSchedulePreset(advanced, "advanced")).toEqual(advanced);
  expect(changeRoutineScheduleTime(advanced, "12:00")).toEqual(advanced);
});
