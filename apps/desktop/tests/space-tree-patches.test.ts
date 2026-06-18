import { expect, test } from "bun:test";
import type { TreeNode } from "../src/features/entry";
import {
  applyReadmeMeta,
  removeReadmeMeta,
  removeTreePath,
  updateTreeFolderSchema,
  updateTreeNodeMeta,
  upsertTreeNode,
} from "../src/features/space/lib/tree-patches";

function node(path: string, children: TreeNode[] = []): TreeNode {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    title: name.replace(/\.md$/i, ""),
    icon: null,
    has_changes: false,
    has_schema: false,
    children,
  };
}

test("upsertTreeNode inserts a created markdown document under its parent", () => {
  const tree = [node("docs", [node("docs/old.md")])];
  const next = upsertTreeNode(tree, "docs", node("docs/new.md"));

  expect(next[0]?.children.map((child) => child.path)).toEqual([
    "docs/old.md",
    "docs/new.md",
  ]);
});

test("removeTreePath removes a deleted folder subtree", () => {
  const tree = [node("docs", [node("docs/a.md")]), node("notes.md")];
  const next = removeTreePath(tree, "docs");

  expect(next.map((item) => item.path)).toEqual(["notes.md"]);
});

test("updateTreeNodeMeta patches changed markdown metadata", () => {
  const tree = [node("notes.md")];
  const next = updateTreeNodeMeta(tree, "notes.md", {
    title: "Notes",
    icon: "N",
    description: "Updated",
  });

  expect(next[0]).toMatchObject({
    title: "Notes",
    icon: "N",
    description: "Updated",
  });
});

test("applyReadmeMeta turns a bare folder into a document folder", () => {
  const tree = [node("docs")];
  const next = applyReadmeMeta(tree, "docs/README.md", {
    title: "Docs",
    icon: "D",
    description: "Guide",
  });

  expect(next[0]).toMatchObject({
    path: "docs/README.md",
    title: "Docs",
    icon: "D",
    description: "Guide",
  });
});

test("applyReadmeMeta inserts a document folder when README arrives first", () => {
  const next = applyReadmeMeta([], "docs/README.md", {
    title: "Docs",
    icon: "D",
    description: "Guide",
  });

  expect(next[0]).toMatchObject({
    name: "docs",
    path: "docs/README.md",
    title: "Docs",
  });
});

test("upsertTreeNode does not duplicate an existing document folder", () => {
  const tree = [
    {
      ...node("docs/README.md"),
      name: "docs",
      title: "Docs",
    },
  ];
  const next = upsertTreeNode(tree, "", node("docs"));

  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    name: "docs",
    path: "docs/README.md",
    title: "Docs",
  });
});

test("removeReadmeMeta turns a document folder back into a bare folder", () => {
  const tree = [
    {
      ...node("docs/README.md"),
      name: "docs",
      title: "Docs",
      children: [node("docs/a.md")],
    },
  ];
  const next = removeReadmeMeta(tree, "docs/README.md");

  expect(next[0]).toMatchObject({
    name: "docs",
    path: "docs",
    title: "docs",
    icon: null,
    description: null,
  });
  expect(next[0]?.children.map((child) => child.path)).toEqual(["docs/a.md"]);
});

test("updateTreeFolderSchema patches collection marker on folder node", () => {
  const tree = [node("docs/README.md")];
  const next = updateTreeFolderSchema(tree, "docs", true);

  expect(next[0]?.has_schema).toBe(true);
});

test("updateTreeFolderSchema inserts a collection folder when schema arrives first", () => {
  const next = updateTreeFolderSchema([], "docs", true);

  expect(next[0]).toMatchObject({
    name: "docs",
    path: "docs",
    title: "docs",
    has_schema: true,
  });
});

test("upsertTreeNode preserves an earlier schema marker", () => {
  const tree = updateTreeFolderSchema([], "docs", true);
  const next = upsertTreeNode(tree, "", node("docs"));

  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    path: "docs",
    has_schema: true,
  });
});
