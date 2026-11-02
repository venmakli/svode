import { expect, test } from "bun:test";

import { createRoutineDraft, defaultRoutineName } from "./routine-create";

test("a new Routine is manual, runs an agent and has no executor yet", () => {
  expect(createRoutineDraft("New routine")).toEqual({
    action: { executor: "", type: "run_agent" },
    body: "",
    description: "",
    enabled: null,
    name: "New routine",
    trigger: { type: "manual" },
  });
});

test("the default name takes the first free number as the owner compares names", () => {
  expect(defaultRoutineName("New routine", [])).toBe("New routine");
  expect(defaultRoutineName("New routine", [{ name: "new  ROUTINE" }])).toBe(
    "New routine 2",
  );
  expect(
    defaultRoutineName(
      "New routine",
      [{ name: "New routine" }, { name: "New routine 2" }],
      ["New routine 3"],
    ),
  ).toBe("New routine 4");
});
