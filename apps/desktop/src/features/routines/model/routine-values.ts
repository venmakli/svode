import type { RoutineRow } from "./types";

export function compareRoutinesByName(left: RoutineRow, right: RoutineRow) {
  return (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

export function routineSearchText(row: RoutineRow) {
  const definition = row.definition;
  return [
    row.name,
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
  if (trigger.type === "schedule") {
    const timeBasis =
      trigger.timeBasis.mode === "local"
        ? "local"
        : `fixed:${trigger.timeBasis.timezone}`;
    return `schedule · ${trigger.cron} · ${timeBasis}`;
  }
  return trigger.event;
}

export function routineActionSummary(row: RoutineRow) {
  const action = row.definition?.action;
  if (!action) return "—";
  return action.type;
}
