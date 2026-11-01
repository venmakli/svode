import { expect, test } from "bun:test";

import type { RoutineItem } from "./types";
import { findRoutineNameConflictPath, routineNameKey } from "./routine-name";

const existing = {
  definitionPath: ".routines/quarterly-review.md",
  id: "routine:existing",
  name: "Quarterly Review",
} as RoutineItem;

test("routine name key normalizes compatibility, whitespace, and case", () => {
  expect(routineNameKey("  ＱＵＡＲＴＥＲＬＹ\u{2003}review ")).toBe(
    routineNameKey("quarterly review"),
  );
  expect(routineNameKey("Resume") === routineNameKey("Résumé")).toBe(false);
});

test("routine name availability excludes only the current item", () => {
  expect(findRoutineNameConflictPath("quarterly review", [existing])).toBe(
    existing.definitionPath,
  );
  expect(
    findRoutineNameConflictPath("quarterly review", [existing], existing.id),
  ).toBeNull();
  expect(findRoutineNameConflictPath("Different", [existing])).toBeNull();
});
