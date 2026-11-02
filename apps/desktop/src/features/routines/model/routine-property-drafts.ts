import { validateRoutineDraft, type RoutineDraftIssue } from "./routine-draft";
import type { RoutineAction, RoutineDefinition, RoutineTrigger } from "./types";

/**
 * The draft of "Trigger" in its popover: the trigger with the action and
 * the enabled state a change of its type adjusts, and the consent to run
 * automatically that a change to a schedule or an event asks for.
 */
export interface RoutineTriggerDraft {
  trigger: RoutineTrigger;
  action: RoutineAction;
  enabled: boolean | null;
  automaticConsent: boolean;
}

export type RoutineTriggerProblem =
  | "automatic_consent"
  | Extract<RoutineDraftIssue, "cron" | "event_field" | "timezone">;

export function routineTriggerDraft(
  definition: RoutineDefinition,
): RoutineTriggerDraft {
  return {
    action: definition.action,
    automaticConsent: false,
    enabled: definition.enabled,
    trigger: definition.trigger,
  };
}

/** The definition with the trigger of `draft`, its other fields untouched. */
export function applyRoutineTriggerDraft(
  definition: RoutineDefinition,
  draft: RoutineTriggerDraft,
): RoutineDefinition {
  return {
    ...definition,
    action: draft.action,
    enabled: draft.enabled,
    trigger: draft.trigger,
  };
}

/** A change of the trigger to a schedule or an event asks for consent. */
export function routineTriggerNeedsConsent(
  saved: RoutineDefinition,
  draft: RoutineTriggerDraft,
): boolean {
  return (
    draft.trigger.type !== "manual" && draft.trigger.type !== saved.trigger.type
  );
}

/** Why the trigger draft cannot be saved; null when it can. */
export function routineTriggerProblem(
  saved: RoutineDefinition,
  draft: RoutineTriggerDraft,
): RoutineTriggerProblem | null {
  const issues = validateRoutineDraft(applyRoutineTriggerDraft(saved, draft));
  for (const issue of ["cron", "timezone", "event_field"] as const) {
    if (issues.has(issue)) return issue;
  }
  if (routineTriggerNeedsConsent(saved, draft) && !draft.automaticConsent) {
    return "automatic_consent";
  }
  return null;
}

/** Whether saving the draft changes the definition. */
export function routineTriggerDraftChanges(
  saved: RoutineDefinition,
  draft: RoutineTriggerDraft,
): boolean {
  return (
    JSON.stringify(applyRoutineTriggerDraft(saved, draft)) !==
    JSON.stringify(saved)
  );
}

/** Why the action draft cannot be saved; null when it can. */
export function routineActionProblem(
  saved: RoutineDefinition,
  action: RoutineAction,
): "set" | null {
  return validateRoutineDraft({ ...saved, action }).has("set") ? "set" : null;
}
