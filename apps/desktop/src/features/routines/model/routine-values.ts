import type { RoutineItem } from "./types";

const EXECUTOR_UNAVAILABLE_CODE = "routine_executor_unavailable";

export function routineDefinitionDiagnostics(item: RoutineItem) {
  return item.diagnostics.filter(
    (diagnostic) => diagnostic.code !== EXECUTOR_UNAVAILABLE_CODE,
  );
}

export function compareRoutinesByName(left: RoutineItem, right: RoutineItem) {
  return (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

export function routineSearchText(item: RoutineItem) {
  const definition = item.definition;
  return [
    item.name,
    item.description,
    item.filename,
    definition?.trigger.type,
    definition?.action.type,
    routineTriggerSummary(item),
    routineActionSummary(item),
    definition?.action.type === "run_agent" ? definition.action.executor : "",
    ...item.diagnostics.map((diagnostic) => diagnostic.message),
  ].join(" ");
}

export function routineTriggerSummary(item: RoutineItem) {
  const trigger = item.definition?.trigger;
  if (!trigger) return "—";
  if (trigger.type === "manual") return "manual";
  if (trigger.type === "schedule") {
    const timeBasis =
      trigger.timeBasis.mode === "local"
        ? "local"
        : `fixed:${trigger.timeBasis.timezone}`;
    return `schedule · ${trigger.cron} · ${timeBasis}`;
  }
  return trigger.event;
}

export function routineActionSummary(item: RoutineItem) {
  const action = item.definition?.action;
  if (!action) return "—";
  return action.type;
}
