import type { RoutineLaunchRefusal, RoutineRow } from "./types";

/** A manual run the launch refused before its first prompt. */
export class RoutineLaunchRefusedError extends Error {
  constructor(
    message: string,
    readonly refusal: RoutineLaunchRefusal,
  ) {
    super(message);
    this.name = "RoutineLaunchRefusedError";
  }
}

/** The id of the Agent Actor a Routine runs, from its `agent:<id>` executor. */
export function routineAgentActorId(row: RoutineRow): string | null {
  const action = row.definition?.action;
  if (action?.type !== "run_agent") return null;
  const executor = action.executor.trim();
  return executor.startsWith("agent:") ? executor.slice("agent:".length) : null;
}
