import { expect, test } from "bun:test";
import type { TreeNode } from "../model/types";
import {
  getProjection,
  flattenTree,
  removeDescendantsOf,
  removeCollapsedChildren,
} from "./tree-dnd-utilities";

test("removeDescendantsOf removes dragged folder descendants from target list", () => {
  const visible = expandedFlatItems();

  expect(visible.map((item) => item.path)).toEqual([
    "docs/README.md",
    "docs/intro.md",
    "docs/nested/README.md",
    "docs/nested/deep.md",
    "tasks/README.md",
  ]);

  const withoutDraggedChildren = removeDescendantsOf(visible, "docs/README.md");

  expect(withoutDraggedChildren.map((item) => item.path)).toEqual([
    "docs/README.md",
    "tasks/README.md",
  ]);
});

test("getProjection uses pointer placement for same-depth reorder", () => {
  const visible = removeDescendantsOf(expandedFlatItems(), "docs/README.md");

  const beforeProjection = getProjection(
    visible,
    "docs/README.md",
    "tasks/README.md",
    0,
    {
      placement: "before",
      allowChild: false,
    },
  );
  expect(beforeProjection).toEqual({
    depth: 0,
    parentPath: "",
    type: "before",
    overPath: "tasks/README.md",
  });

  const afterProjection = getProjection(
    visible,
    "docs/README.md",
    "tasks/README.md",
    0,
    {
      placement: "after",
      allowChild: false,
    },
  );
  expect(afterProjection).toEqual({
    depth: 0,
    parentPath: "",
    type: "after",
    overPath: "tasks/README.md",
  });
});

test("getProjection only nests on central row intent plus horizontal offset", () => {
  const visible = removeDescendantsOf(expandedFlatItems(), "docs/README.md");

  const siblingProjection = getProjection(
    visible,
    "docs/README.md",
    "tasks/README.md",
    0,
    {
      placement: "after",
      allowChild: true,
    },
  );
  expect(siblingProjection).toEqual({
    depth: 0,
    parentPath: "",
    type: "after",
    overPath: "tasks/README.md",
  });

  const childProjection = getProjection(
    visible,
    "docs/README.md",
    "tasks/README.md",
    16,
    {
      placement: "after",
      allowChild: true,
    },
  );
  expect(childProjection).toEqual({
    depth: 1,
    parentPath: "tasks",
    type: "child",
    overPath: "tasks/README.md",
  });
});

function sampleTree(): TreeNode[] {
  return [
    folder("docs", "docs/README.md", [
      doc("intro.md", "docs/intro.md"),
      folder("nested", "docs/nested/README.md", [
        doc("deep.md", "docs/nested/deep.md"),
      ]),
    ]),
    collection("tasks", "tasks/README.md"),
  ];
}

function expandedFlatItems() {
  return removeCollapsedChildren(
    flattenTree(sampleTree()),
    new Set(["docs/README.md", "docs/nested/README.md"]),
  );
}

function doc(name: string, path: string): TreeNode {
  return {
    name,
    path,
    title: name,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
  };
}

function folder(name: string, path: string, children: TreeNode[]): TreeNode {
  return {
    name,
    path,
    title: name,
    icon: null,
    has_changes: false,
    has_schema: false,
    hasChildren: children.length > 0,
    kind: "folder",
    children,
  };
}

function collection(name: string, path: string): TreeNode {
  return {
    name,
    path,
    title: name,
    icon: null,
    has_changes: false,
    has_schema: true,
    hasChildren: false,
    kind: "collection",
    children: [],
  };
}
