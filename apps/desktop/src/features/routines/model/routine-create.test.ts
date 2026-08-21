import { expect, test } from "bun:test";

import {
  changeRoutineAction,
  changeRoutineEvent,
  changeRoutineTrigger,
} from "./routine-draft";
import {
  createRoutineDraft,
  firstInvalidRoutineCreateStep,
  isRoutineCreateStepValid,
  normalizeRoutineCreateCandidate,
  routineDefinitionMatchesCandidate,
  type RoutineCreateValidationContext,
} from "./routine-create";

const actor = {
  description: null,
  label: "Documentation Agent",
  ownerLabel: "root",
  value: "agent:01arz3ndektsv4rrffq69g5fav" as const,
};

const ready: RoutineCreateValidationContext = {
  collectionOwner: true,
  executorError: null,
  executorLoading: false,
  executors: [actor],
};

test("create draft remains runtime-only until all four step gates are valid", () => {
  const draft = createRoutineDraft();
  expect(firstInvalidRoutineCreateStep(draft, ready)).toBe("basics");

  const valid = {
    ...draft,
    action: { executor: actor.value, type: "run_agent" as const },
    title: "Review changes",
  };
  expect(isRoutineCreateStepValid("basics", valid, ready)).toBe(true);
  expect(isRoutineCreateStepValid("trigger", valid, ready)).toBe(true);
  expect(isRoutineCreateStepValid("action", valid, ready)).toBe(true);
  expect(firstInvalidRoutineCreateStep(valid, ready)).toBeNull();
});

test("manual, schedule and both Collection event actions use one definition model", () => {
  const manual = {
    ...createRoutineDraft(),
    action: { executor: actor.value, type: "run_agent" as const },
    title: "Review",
  };
  const schedule = changeRoutineTrigger(manual, "schedule", "Asia/Novosibirsk");
  expect(firstInvalidRoutineCreateStep(schedule, ready)).toBeNull();
  expect(normalizeRoutineCreateCandidate(schedule).enabled).toBe(false);

  const event = changeRoutineTrigger(manual, "event", "UTC");
  expect(firstInvalidRoutineCreateStep(event, ready)).toBeNull();
  const updateProperties = changeRoutineAction(event, "update_properties");
  const validUpdate = {
    ...updateProperties,
    action: {
      set: { reviewed: true },
      target: "trigger.entry" as const,
      type: "update_properties" as const,
    },
  };
  expect(firstInvalidRoutineCreateStep(validUpdate, ready)).toBeNull();

  const fieldEvent = changeRoutineEvent(event, "collection.field_changed");
  expect(firstInvalidRoutineCreateStep(fieldEvent, ready)).toBe("trigger");
  expect(
    isRoutineCreateStepValid("trigger", event, {
      ...ready,
      collectionOwner: false,
    }),
  ).toBe(false);
});

test("actor loading, failure and stale selection block the action gate", () => {
  const draft = {
    ...createRoutineDraft(),
    action: { executor: actor.value, type: "run_agent" as const },
    title: "Review",
  };
  expect(
    isRoutineCreateStepValid("action", draft, {
      ...ready,
      executorLoading: true,
    }),
  ).toBe(false);
  expect(
    isRoutineCreateStepValid("action", draft, {
      ...ready,
      executorError: "catalog failed",
    }),
  ).toBe(false);
  expect(
    isRoutineCreateStepValid("action", draft, { ...ready, executors: [] }),
  ).toBe(false);
});

test("create normalization disables automation and supports exact reconciliation", () => {
  const schedule = changeRoutineTrigger(
    {
      ...createRoutineDraft(),
      action: { executor: actor.value, type: "run_agent" },
      title: "  Weekly review  ",
    },
    "schedule",
    "UTC",
  );
  const candidate = normalizeRoutineCreateCandidate({
    ...schedule,
    description: "  Summary  ",
    enabled: true,
  });
  expect(candidate.title).toBe("Weekly review");
  expect(candidate.description).toBe("Summary");
  expect(candidate.enabled).toBe(false);
  expect(routineDefinitionMatchesCandidate(candidate, schedule)).toBe(false);
  expect(
    routineDefinitionMatchesCandidate(candidate, {
      ...schedule,
      description: "Summary",
    }),
  ).toBe(true);
});
