import { expect, test } from "bun:test";

import { routineMutationWarningDescription } from "./routine-mutation-warning";

test("routine mutation warnings localize actual filename paths", () => {
  for (const code of [
    "routine_filename_projection",
    "routine_filename_collision",
    "routine_rename_collision",
  ]) {
    const description = routineMutationWarningDescription({
      code,
      field: null,
      message: "fallback",
      path: ".routines/日本語 Routine.md",
    });
    expect(description.includes(".routines/日本語 Routine.md")).toBe(true);
  }
});

test("routine mutation warnings preserve existing diagnostic messages", () => {
  expect(
    routineMutationWarningDescription({
      code: "routine_projection_refresh_failed",
      field: null,
      message: "refresh failed",
      path: null,
    }),
  ).toBe("refresh failed");
});
