import type {
  RoutineAction,
  RoutineActionType,
  RoutineDefinition,
  RoutineEventType,
  RoutineTrigger,
  RoutineTriggerType,
} from "./types";
import { isValidTimezone } from "./routine-time-basis";

export type RoutineDraftIssue =
  | "cron"
  | "event_field"
  | "executor"
  | "set"
  | "timezone";

export function changeRoutineTrigger(
  definition: RoutineDefinition,
  type: RoutineTriggerType,
): RoutineDefinition {
  const trigger: RoutineTrigger =
    type === "manual"
      ? { type: "manual" }
      : type === "schedule"
        ? {
            cron: "0 9 * * 1-5",
            missedRuns: "skip",
            timeBasis: { mode: "local" },
            type: "schedule",
          }
        : {
            event: "collection.entry_created",
            match: null,
            type: "event",
          };
  const action =
    type === "event" ? definition.action : toRunAgent(definition.action);
  return {
    ...definition,
    action,
    enabled: type === "manual" ? null : false,
    trigger,
  };
}

export function changeRoutineAction(
  definition: RoutineDefinition,
  type: RoutineActionType,
): RoutineDefinition {
  const action: RoutineAction =
    type === "run_agent"
      ? toRunAgent(definition.action)
      : {
          set: {},
          target: "trigger.entry",
          type: "update_properties",
        };
  return { ...definition, action };
}

export function changeRoutineEvent(
  definition: RoutineDefinition,
  event: RoutineEventType,
): RoutineDefinition {
  if (definition.trigger.type !== "event") return definition;
  const action =
    event === "collection.entry_deleted" &&
    definition.action.type === "update_properties"
      ? toRunAgent(definition.action)
      : definition.action;
  return {
    ...definition,
    action,
    trigger: {
      event,
      match:
        event === "collection.field_changed"
          ? (definition.trigger.match ?? { field: "" })
          : null,
      type: "event",
    },
  };
}

export function validateRoutineDraft(
  definition: RoutineDefinition,
): ReadonlySet<RoutineDraftIssue> {
  const issues = new Set<RoutineDraftIssue>();
  if (definition.trigger.type === "schedule") {
    if (definition.trigger.cron.trim().split(/\s+/).length !== 5) {
      issues.add("cron");
    }
    if (
      definition.trigger.timeBasis.mode === "fixed" &&
      !isValidTimezone(definition.trigger.timeBasis.timezone)
    ) {
      issues.add("timezone");
    }
  }
  if (
    definition.trigger.type === "event" &&
    definition.trigger.event === "collection.field_changed" &&
    !definition.trigger.match?.field.trim()
  ) {
    issues.add("event_field");
  }
  if (definition.action.type === "run_agent") {
    if (!/^agent:[0-9a-hjkmnp-tv-z]{26}$/.test(definition.action.executor)) {
      issues.add("executor");
    }
  } else if (
    Object.keys(definition.action.set).length === 0 ||
    Object.keys(definition.action.set).some((key) => !key.trim())
  ) {
    issues.add("set");
  }
  return issues;
}

export function routineValueInput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

export function parseRoutineValueInput(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function toRunAgent(action: RoutineAction): RoutineAction {
  return {
    executor: action.type === "run_agent" ? action.executor : "",
    type: "run_agent",
  };
}
