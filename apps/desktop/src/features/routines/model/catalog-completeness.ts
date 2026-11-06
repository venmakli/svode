import type { RoutineCatalogSnapshot } from "./types";

/**
 * Operational diagnostics that lose no Routine: the files were read, only the
 * local definition or run cache or the schedule was not refreshed.
 */
const routinePreservingDiagnostics: ReadonlySet<string> = new Set([
  "routine_cache_unavailable",
  "routine_run_cache_unavailable",
  "routine_local_timezone_unavailable",
]);

/**
 * Whether a read of the Routines of an owner has every Routine, so a Routine
 * it lacks is gone. Any other diagnostic, known or new, may have lost the
 * Routines of the owner or a file; a Routine without a readable id may be
 * the one a reference names.
 */
export function isRoutineCatalogReadComplete(
  snapshot: RoutineCatalogSnapshot,
): boolean {
  return (
    snapshot.diagnostics.every((diagnostic) =>
      routinePreservingDiagnostics.has(diagnostic.code),
    ) && snapshot.items.every((item) => item.routineId !== null)
  );
}
