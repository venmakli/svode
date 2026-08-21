import type { AgentActorOption } from "@/features/actors";

import { validateRoutineDraft } from "./routine-draft";
import type { RoutineDefinition } from "./types";

export type RoutineCreateStep = "basics" | "trigger" | "action" | "review";

export const ROUTINE_CREATE_STEPS: readonly RoutineCreateStep[] = [
  "basics",
  "trigger",
  "action",
  "review",
];

export interface RoutineCreateValidationContext {
  collectionOwner: boolean;
  executorError: string | null;
  executorLoading: boolean;
  executors: readonly AgentActorOption[];
}

export function createRoutineDraft(): RoutineDefinition {
  return {
    action: { executor: "", type: "run_agent" },
    body: "",
    description: "",
    enabled: null,
    title: "",
    trigger: { type: "manual" },
  };
}

export function cloneRoutineDefinition(
  definition: RoutineDefinition,
): RoutineDefinition {
  return structuredClone(definition);
}

export function normalizeRoutineCreateCandidate(
  definition: RoutineDefinition,
): RoutineDefinition {
  return {
    ...cloneRoutineDefinition(definition),
    description: definition.description.trim(),
    enabled: definition.trigger.type === "manual" ? null : false,
    title: definition.title.trim(),
  };
}

export function areRoutineDefinitionsEqual(
  left: RoutineDefinition,
  right: RoutineDefinition,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isRoutineCreateStepValid(
  step: RoutineCreateStep,
  definition: RoutineDefinition,
  context: RoutineCreateValidationContext,
): boolean {
  const issues = validateRoutineDraft(definition);
  if (step === "basics") {
    const titleLength = definition.title.trim().length;
    return (
      titleLength > 0 &&
      titleLength <= 240 &&
      definition.description.length <= 2_000
    );
  }
  if (step === "trigger") {
    return (
      (context.collectionOwner || definition.trigger.type !== "event") &&
      !issues.has("cron") &&
      !issues.has("event_field") &&
      !issues.has("timezone")
    );
  }
  if (step === "action") {
    if (issues.has("executor") || issues.has("set")) return false;
    if (definition.action.type !== "run_agent") return true;
    const executor = definition.action.executor;
    return (
      !context.executorLoading &&
      !context.executorError &&
      context.executors.some((option) => option.value === executor)
    );
  }
  return ROUTINE_CREATE_STEPS.slice(0, -1).every((candidate) =>
    isRoutineCreateStepValid(candidate, definition, context),
  );
}

export function firstInvalidRoutineCreateStep(
  definition: RoutineDefinition,
  context: RoutineCreateValidationContext,
): Exclude<RoutineCreateStep, "review"> | null {
  for (const step of ROUTINE_CREATE_STEPS.slice(0, -1)) {
    if (!isRoutineCreateStepValid(step, definition, context)) {
      return step as Exclude<RoutineCreateStep, "review">;
    }
  }
  return null;
}

export function routineDefinitionMatchesCandidate(
  definition: RoutineDefinition,
  candidate: RoutineDefinition,
) {
  return areRoutineDefinitionsEqual(
    normalizeRoutineCreateCandidate(definition),
    normalizeRoutineCreateCandidate(candidate),
  );
}
