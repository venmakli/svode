import { expect, test } from "bun:test";

import type { RoutineRow } from "./types";
import { findRoutineNameConflictPath, routineNameKey } from "./routine-name";

const existing = {
  definitionPath: ".routines/quarterly-review.md",
  id: "routine:existing",
  name: "Quarterly Review",
} as RoutineRow;

test("routine name key normalizes compatibility, whitespace, and case", () => {
  expect(routineNameKey("  ＱＵＡＲＴＥＲＬＹ\u{2003}review ")).toBe(
    routineNameKey("quarterly review"),
  );
  expect(routineNameKey("Resume") === routineNameKey("Résumé")).toBe(false);
});

test("routine name availability excludes only the current row", () => {
  expect(findRoutineNameConflictPath("quarterly review", [existing])).toBe(
    existing.definitionPath,
  );
  expect(
    findRoutineNameConflictPath("quarterly review", [existing], existing.id),
  ).toBeNull();
  expect(findRoutineNameConflictPath("Different", [existing])).toBeNull();
});
