import * as m from "@/paraglide/messages.js";

import type { RoutineDiagnostic } from "../model/types";

export function routineMutationWarningDescription(
  warning: RoutineDiagnostic,
): string {
  if (warning.code === "routine_filename_projection" && warning.path) {
    return m.routines_filename_adjusted_description({ path: warning.path });
  }
  if (warning.code === "routine_filename_collision" && warning.path) {
    return m.routines_filename_allocated_description({ path: warning.path });
  }
  if (warning.code === "routine_rename_collision" && warning.path) {
    return m.routines_filename_collision_description({ path: warning.path });
  }
  return warning.message;
}
