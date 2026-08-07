import { expect, test } from "bun:test";

import {
  changeRoutineAction,
  changeRoutineEvent,
  changeRoutineTrigger,
  parseRoutineValueInput,
  validateRoutineDraft,
} from "./routine-draft";
import type { RoutineDefinition } from "./types";

const manual: RoutineDefinition = {
  action: {
    executor: "agent:01arz3ndektsv4rrffq69g5fav",
    type: "run_agent",
  },
  body: "Review changes.",
  description: "",
  enabled: null,
  title: "Review",
  trigger: { type: "manual" },
};

test("trigger changes clear incompatible config and disable automatic drafts", () => {
  const schedule = changeRoutineTrigger(manual, "schedule", "Asia/Novosibirsk");
  expect({ enabled: schedule.enabled, trigger: schedule.trigger }).toEqual({
    enabled: false,
    trigger: {
      cron: "0 9 * * 1-5",
      missedRuns: "skip",
      timezone: "Asia/Novosibirsk",
      type: "schedule",
    },
  });

  const nextManual = changeRoutineTrigger(schedule, "manual", "UTC");
  expect(nextManual.enabled).toBeNull();
  expect(nextManual.trigger).toEqual({ type: "manual" });
});

test("delete events force run_agent and field events own match config", () => {
  const event = changeRoutineTrigger(manual, "event", "UTC");
  const update = changeRoutineAction(event, "update_properties");
  const fieldChanged = changeRoutineEvent(update, "collection.field_changed");
  expect(fieldChanged.trigger).toEqual({
    event: "collection.field_changed",
    match: { field: "" },
    type: "event",
  });
  expect(
    changeRoutineEvent(fieldChanged, "collection.entry_deleted").action.type,
  ).toBe("run_agent");
});

test("validation covers schedule, executor and update set", () => {
  const schedule = changeRoutineTrigger(manual, "schedule", "");
  const invalid = {
    ...schedule,
    action: { executor: "", type: "run_agent" as const },
    trigger: { ...schedule.trigger, cron: "0 9 *", timezone: "" },
  };
  expect([...validateRoutineDraft(invalid)]).toEqual([
    "cron",
    "timezone",
    "executor",
  ]);

  const event = changeRoutineAction(
    changeRoutineTrigger(manual, "event", "UTC"),
    "update_properties",
  );
  expect(validateRoutineDraft(event).has("set")).toBe(true);
});

test("property values accept JSON scalars and plain sentinels", () => {
  expect(parseRoutineValueInput("true")).toBe(true);
  expect(parseRoutineValueInput("null")).toBeNull();
  expect(parseRoutineValueInput("{{datetime}}")).toBe("{{datetime}}");
});

test("validation rejects unknown timezones and blank property keys", () => {
  const schedule = changeRoutineTrigger(manual, "schedule", "Mars/Olympus");
  expect(validateRoutineDraft(schedule).has("timezone")).toBe(true);

  const event = changeRoutineAction(
    changeRoutineTrigger(manual, "event", "UTC"),
    "update_properties",
  );
  expect(
    validateRoutineDraft({
      ...event,
      action: {
        set: { "": true },
        target: "trigger.entry",
        type: "update_properties",
      },
    }).has("set"),
  ).toBe(true);
});
