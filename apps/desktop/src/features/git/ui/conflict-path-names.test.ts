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
