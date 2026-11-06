import { expect, test } from "bun:test";

import type {
  RoutineCatalogSnapshot,
  RoutineDiagnostic,
  RoutineItem,
} from "../model/types";
import { routineNavigationSource } from "./use-routine-navigation-source";

const daily: RoutineItem = {
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
  items: readonly RoutineItem[] = [daily],
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
  return { code, field: null, message: code, path: ".routines/weekly.md" };
}

test("the Routine source names Routines by id and confirms absence only after a complete read", () => {
  const read = routineNavigationSource(
    snapshot([diagnostic("routine_run_cache_unavailable")]),
  );
  expect(read.items.get("daily")?.title).toBe("Daily");
  expect(read.confirmsAbsence).toBe(true);

  const unreadFile = routineNavigationSource(
    snapshot([diagnostic("routine_file_unavailable")]),
  );
  expect(unreadFile.items.get("daily")?.title).toBe("Daily");
  expect(unreadFile.confirmsAbsence).toBe(false);

  const withoutId = routineNavigationSource(
    snapshot([], [daily, { ...daily, id: "broken", routineId: null }]),
  );
  expect([...withoutId.items.keys()]).toEqual(["daily"]);
  expect(withoutId.confirmsAbsence).toBe(false);
});
