import { expect, test } from "bun:test";
import type { TreeNode } from "../src/features/entry";
import {
  applyReadmeMetaToParents,
  buildLoadedTree,
  flattenChildrenByParentPath,
} from "../src/features/space/lib/tree-cache";
import {
  isSystemIgnoredTreePath,
  treeRowParentPath,
} from "../src/features/space/lib/tree-patches";

function node(
  path: string,
  children: TreeNode[] = [],
  hasChildren = children.length > 0,
): TreeNode {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    title: name.replace(/\.md$/i, ""),
    icon: null,
    has_changes: false,
    has_schema: false,
    hasChildren,
    children,
  };
}

test("collapsed loaded descendants are not attached to rendered tree", () => {
  const childrenByParent = flattenChildrenByParentPath([
    node("docs", [node("docs/child.md")]),
  ]);

  const tree = buildLoadedTree(childrenByParent, []);

  expect(tree).toEqual([{ ...node("docs", [], true), children: [] }]);
});

test("expanded loaded parent attaches only its direct children", () => {
  const childrenByParent = flattenChildrenByParentPath([
    node("docs", [node("docs/guides", [node("docs/guides/a.md")])]),
  ]);

  const tree = buildLoadedTree(childrenByParent, ["docs"]);

  expect(tree[0]?.children.map((child) => child.path)).toEqual(["docs/guides"]);
  expect(tree[0]?.children[0]?.children).toEqual([]);
});

test("readme metadata patch preserves known children from loaded parent cache", () => {
  const childrenByParent = {
    "": [node("docs", [], false)],
    docs: [node("docs/child.md")],
  };

  const next = applyReadmeMetaToParents(childrenByParent, "docs/README.md", {
    title: "Docs",
    icon: null,
  });

  expect(next?.[""]?.[0]).toMatchObject({
    path: "docs/README.md",
    title: "Docs",
    hasChildren: true,
  });
});

test("treeRowParentPath maps entry paths to sidebar row parents", () => {
  expect(treeRowParentPath("note.md")).toBe("");
  expect(treeRowParentPath("docs/note.md")).toBe("docs");
  expect(treeRowParentPath("docs/README.md")).toBe("");
  expect(treeRowParentPath("docs/guides/README.md")).toBe("docs");
});

test("system ignored tree paths are skipped by parent helpers", () => {
  expect(isSystemIgnoredTreePath(".svode/config.json")).toBe(true);
  expect(isSystemIgnoredTreePath("docs/.cache/item.md")).toBe(true);
  expect(treeRowParentPath(".git/config")).toBeNull();
  expect(treeRowParentPath(".notes.md")).toBe("");
});
