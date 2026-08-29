import { expect, test } from "bun:test";
import type { TreeNode } from "../model/types";
import { buildSpaceBreadcrumbSegments } from "./space-breadcrumbs";

function node(
  input: Partial<TreeNode> & Pick<TreeNode, "name" | "path">,
): TreeNode {
  return {
    title: input.name,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
    ...input,
  };
}

test("keeps Collection owners structural in breadcrumbs", () => {
  const tree = [
    node({
      name: "tasks",
      path: "tasks/README.md",
      title: "Tasks",
      has_schema: true,
      children: [
        node({ name: "today.md", path: "tasks/today.md", title: "Today" }),
      ],
    }),
  ];

  expect(buildSpaceBreadcrumbSegments("tasks/today.md", tree)).toEqual([
    { label: "Tasks", path: "tasks", ownerKind: "collection" },
    { label: "Today", path: "tasks/today.md", ownerKind: null },
  ]);
});

test("keeps an ordinary directory-backed Page as an Artifact breadcrumb", () => {
  const tree = [
    node({
      name: "notes",
      path: "notes/README.md",
      title: "Notes",
    }),
  ];

  expect(buildSpaceBreadcrumbSegments("notes/README.md", tree)).toEqual([
    { label: "Notes", path: "notes/README.md", ownerKind: null },
  ]);
});
