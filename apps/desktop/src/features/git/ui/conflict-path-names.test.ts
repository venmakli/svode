import { expect, test } from "bun:test";
import * as m from "@/paraglide/messages.js";
import { conflictPathName } from "./conflict-path-names";

const spaces = [
  {
    path: "/project",
    name: "Project",
    nodes: new Map([
      ["plan.md", "Plan"],
      ["tasks", "Tasks"],
    ]),
  },
  {
    path: "/project/docs",
    name: "Docs",
    nodes: new Map([["guide/README.md", "Guide"]]),
  },
];

test("conflicted paths are named by their Page, Collection or file", () => {
  expect(conflictPathName("/project", "plan.md", spaces)).toBe("Plan");
  expect(conflictPathName("/project", "tasks/schema.yaml", spaces)).toBe(
    m.git_conflict_name_schema({ name: "Tasks" }),
  );
  // The deepest Space holding the path names it.
  expect(conflictPathName("/project", "docs/guide/README.md", spaces)).toBe(
    "Guide",
  );
  expect(conflictPathName("/project", "README.md", spaces)).toBe("Project");
  expect(conflictPathName("/project", "data/table.json", spaces)).toBe(
    "table.json",
  );
});

test("the title Svode read from the versions of a Page comes before the tree", () => {
  // An item of a Collection the sidebar has not loaded.
  expect(
    conflictPathName("/project", "tasks/second.md", spaces, "Second"),
  ).toBe("Second");
  expect(conflictPathName("/project", "plan.md", spaces, "Plan v2")).toBe(
    "Plan v2",
  );
  // Without it, the tree and the file name as before.
  expect(conflictPathName("/project", "tasks/second.md", spaces)).toBe(
    "second.md",
  );
  expect(conflictPathName("/project", "plan.md", spaces, undefined)).toBe(
    "Plan",
  );
});
