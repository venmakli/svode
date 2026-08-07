import type { RoutineRow } from "./types";

export function compareRoutinesByTitle(left: RoutineRow, right: RoutineRow) {
  return (
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

export function routineSearchText(row: RoutineRow) {
  const definition = row.definition;
  return [
    row.title,
    row.description,
    row.filename,
    definition?.trigger.type,
    definition?.action.type,
    routineTriggerSummary(row),
    routineActionSummary(row),
    definition?.action.type === "run_agent" ? definition.action.executor : "",
    ...row.diagnostics.map((diagnostic) => diagnostic.message),
  ].join(" ");
}

export function routineTriggerSummary(row: RoutineRow) {
  const trigger = row.definition?.trigger;
  if (!trigger) return "—";
  if (trigger.type === "manual") return "manual";
  if (trigger.type === "schedule") return `schedule · ${trigger.cron}`;
  return trigger.event;
}

export function routineActionSummary(row: RoutineRow) {
  const action = row.definition?.action;
  if (!action) return "—";
  return action.type;
}
