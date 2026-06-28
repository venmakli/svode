import { expect, test } from "bun:test";
import type { TreeNode } from "../model/types";
import {
  hasExpandedSidebarTreeState,
  loadedExpandableTreePaths,
  nextSidebarTreeExpansionAction,
  sidebarTreeExpansionPaths,
} from "./sidebar-tree-expansion";

test("loadedExpandableTreePaths expands only parents whose children are already loaded", () => {
  expect(
    loadedExpandableTreePaths({
      "": [folder("docs/README.md"), folder("empty/README.md"), doc("todo.md")],
      docs: [doc("docs/intro.md"), folder("docs/nested/README.md")],
      "docs/nested": [doc("docs/nested/deep.md")],
      empty: [],
    }),
  ).toEqual(["docs/README.md", "docs/nested/README.md"]);
});

test("sidebarTreeExpansionPaths collapses without loading and expands loaded nodes", () => {
  const childrenByParentPath = {
    "": [folder("docs/README.md")],
    docs: [doc("docs/intro.md")],
  };

  expect(sidebarTreeExpansionPaths("collapse", childrenByParentPath)).toEqual(
    [],
  );
  expect(sidebarTreeExpansionPaths("expand", childrenByParentPath)).toEqual([
    "docs/README.md",
  ]);
});

test("nextSidebarTreeExpansionAction uses scope rows and tree paths", () => {
  const collapsed = {
    expandedPaths: { root: [], space: [] },
    scopeOpenById: { root: false, space: false },
    spaceIds: ["root", "space"],
  };
  expect(hasExpandedSidebarTreeState(collapsed)).toBe(false);
  expect(nextSidebarTreeExpansionAction(collapsed)).toBe("expand");

  expect(
    nextSidebarTreeExpansionAction({
      ...collapsed,
      scopeOpenById: { root: true, space: false },
    }),
  ).toBe("collapse");
  expect(
    nextSidebarTreeExpansionAction({
      ...collapsed,
      expandedPaths: { root: [], space: ["docs/README.md"] },
    }),
  ).toBe("collapse");
});

function doc(path: string): TreeNode {
  return {
    name: path,
    path,
    title: path,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
  };
}

function folder(path: string): TreeNode {
  return {
    ...doc(path),
    hasChildren: true,
    kind: "folder",
  };
}
