import { expect, test } from "bun:test";

import { isRoutineCatalogReadComplete } from "./catalog-completeness";
import type {
  RoutineCatalogSnapshot,
  RoutineDiagnostic,
  RoutineItem,
} from "./types";

const routine: RoutineItem = {
  definition: null,
  definitionPath: ".routines/daily.md",
  description: "",
  diagnostics: [],
  filename: "daily.md",
  fingerprint: "file:one",
  id: ".routines/daily.md",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  name: "Daily",
  nextRunAt: null,
  routineId: "daily",
  valid: true,
};

function snapshot(
  diagnostics: readonly RoutineDiagnostic[],
  items: readonly RoutineItem[] = [routine],
): RoutineCatalogSnapshot {
  return {
    catalogFingerprint: "routine-catalog:one",
    diagnostics,
    items,
    ownerPath: ".",
    refreshedAt: "2026-11-06T00:00:00.000Z",
    resolvedOwnerKind: "project",
    spaceId: "root",
  };
}

function diagnostic(code: string): RoutineDiagnostic {
  return { code, field: null, message: code, path: ".routines" };
}

test("a read of Routines without diagnostics is complete", () => {
  expect(isRoutineCatalogReadComplete(snapshot([]))).toBe(true);
  expect(isRoutineCatalogReadComplete(snapshot([], []))).toBe(true);
});

test("operational diagnostics lose no Routine", () => {
  expect(
    isRoutineCatalogReadComplete(
      snapshot([
        diagnostic("routine_cache_unavailable"),
        diagnostic("routine_run_cache_unavailable"),
        diagnostic("routine_local_timezone_unavailable"),
      ]),
    ),
  ).toBe(true);
});

test("a diagnostic of the catalog or of a file, or an unknown one, may have lost Routines", () => {
  for (const code of [
    "routine_catalog_unavailable",
    "routine_catalog_unsafe",
    "routine_owner_unavailable",
    "routine_file_unavailable",
    "routine_file_unsafe",
    "routine_file_not_utf8",
    "routine_filename_invalid",
    "routine_catalog_limit_exceeded",
    "routine_future_problem",
  ]) {
    expect(
      isRoutineCatalogReadComplete(
        snapshot([diagnostic("routine_cache_unavailable"), diagnostic(code)]),
      ),
    ).toBe(false);
  }
});

test("a Routine without a readable id may be the one a row names", () => {
  expect(
    isRoutineCatalogReadComplete(
      snapshot([], [routine, { ...routine, id: "broken", routineId: null }]),
    ),
  ).toBe(false);
});
