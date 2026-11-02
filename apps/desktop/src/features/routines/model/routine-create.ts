import { routineNameKey } from "./routine-name";
import type { RoutineDefinition, RoutineItem } from "./types";

/**
 * The definition of a new Routine: a manual trigger, an agent to run with no
 * executor chosen yet, and `name`.
 */
export function createRoutineDraft(name: string): RoutineDefinition {
  return {
    action: { executor: "", type: "run_agent" },
    body: "",
    description: "",
    enabled: null,
    name,
    trigger: { type: "manual" },
  };
}

/**
 * The first free default name of a new Routine among the owner's Routines:
 * `base`, then `base 2`, `base 3`… compared as the owner compares names.
 */
export function defaultRoutineName(
  base: string,
  items: readonly Pick<RoutineItem, "name">[],
  taken: readonly string[] = [],
): string {
  const used = new Set(
    [...items.map((item) => item.name), ...taken].map(routineNameKey),
  );
  if (!used.has(routineNameKey(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const name = `${base} ${suffix}`;
    if (!used.has(routineNameKey(name))) return name;
  }
}
