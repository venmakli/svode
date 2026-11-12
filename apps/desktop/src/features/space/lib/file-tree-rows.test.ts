import { expect, test } from "bun:test";
import type { TreeNode } from "../model/types";
import { buildFileTreeRows, treeRowInset } from "./file-tree-rows";

const node = (
  path: string,
  extra: Partial<TreeNode> = {},
  children: TreeNode[] = [],
): TreeNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  title: path,
  icon: null,
  has_changes: false,
  has_schema: false,
  children,
  ...extra,
});

const rowsOf = (result: ReturnType<typeof buildFileTreeRows>) =>
  result.rows.map((row) =>
    row.kind === "node"
      ? [row.node.path, row.depth, row.spaceBefore]
      : [`loading ${row.index}`, row.depth, row.spaceBefore],
  );

test("rows keep the spacing of the nested lists they replace", () => {
  const tree = [
    node("a.md"),
    node("guide/README.md", { hasChildren: true }, [
      node("guide/one.md"),
      node("guide/deep", { hasChildren: true }, [node("guide/deep/x.md")]),
    ]),
    node("b.md"),
  ];
  const result = buildFileTreeRows(
    tree,
    new Set(["guide/README.md", "guide/deep"]),
    undefined,
  );
  // List padding 2, gap 4 between siblings, 2 more per closed nested list.
  expect(rowsOf(result)).toEqual([
    ["a.md", 0, 2],
    ["guide/README.md", 0, 4],
    ["guide/one.md", 1, 2],
    ["guide/deep", 1, 4],
    ["guide/deep/x.md", 2, 2],
    ["b.md", 0, 2 + 2 + 4],
  ]);
  expect(result.trailingSpace).toBe(2);
  expect(result.indexByPath.get("guide/deep/x.md")).toBe(4);
  expect(result.nodeByPath.get("b.md")).toBe(tree[2]);
});

test("collapsed folders hide their children and loading folders show placeholders", () => {
  const tree = [
    node("closed", { hasChildren: true }, [node("closed/x.md")]),
    node("loading", { hasChildren: true }),
    node("empty"),
  ];
  const result = buildFileTreeRows(tree, new Set(["loading", "empty"]), {
    loading: true,
  });
  expect(rowsOf(result)).toEqual([
    ["closed", 0, 2],
    ["loading", 0, 4],
    ["loading 0", 1, 2],
    ["loading 1", 1, 4],
    // An expanded empty folder keeps its empty list: 2 + 2 above the gap.
    ["empty", 0, 2 + 4],
  ]);
  expect(result.trailingSpace).toBe(2 + 2 + 2);
  const expanded = result.rows.map((row) =>
    row.kind === "node" ? [row.expandable, row.expanded] : null,
  );
  expect(expanded).toEqual([[true, false], [true, true], null, null, [true, true]]);
});

test("an App or leaf Page without children is not expandable", () => {
  const result = buildFileTreeRows(
    [node("board", { has_app: true }), node("doc.md")],
    new Set(["board", "doc.md"]),
    undefined,
  );
  expect(
    result.rows.map((row) => (row.kind === "node" ? row.expandable : null)),
  ).toEqual([false, false]);
});

test("a nested row is indented like the nested list", () => {
  expect(treeRowInset(0)).toEqual({ left: 8, right: -0 });
  expect(treeRowInset(2)).toEqual({ left: 8 + 2 * 17, right: -2 });
});
