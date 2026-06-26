import { expect, test } from "bun:test";
import type { TreeNode } from "../model/types";
import type { Projection } from "./tree-dnd-utilities";
import {
  buildCrossParentMovePlan,
  buildCrossParentMoveOrder,
  buildSameParentReorderOrder,
  getChildNestConversionPlan,
  movedDocumentPath,
  prepareTreeDrag,
} from "./tree-dnd-commit-plan";

test("leaf document move plan moves the markdown file itself", () => {
  const tree = sampleTree();
  const drag = prepareTreeDrag(tree, "note.md", afterIntoArchive());

  expect(drag?.fromParent).toBe("");
  expect(drag?.toParent).toBe("archive");

  const movePlan = buildCrossParentMovePlan(tree, drag!);
  expect(movePlan.isBareFolder).toBe(false);
  expect(movePlan.isDocFolder).toBe(false);
  expect(movePlan.movePath).toBe("note.md");
  expect(movedDocumentPath(movePlan, "archive/note.md")).toBe(
    "archive/note.md",
  );
});

test("document folder move plan moves the directory and reopens README", () => {
  const tree = sampleTree();
  const drag = prepareTreeDrag(tree, "topic/README.md", afterIntoArchive());

  expect(drag?.fromParent).toBe("");
  expect(drag?.toParent).toBe("archive");

  const movePlan = buildCrossParentMovePlan(tree, drag!);
  expect(movePlan.isBareFolder).toBe(false);
  expect(movePlan.isDocFolder).toBe(true);
  expect(movePlan.movePath).toBe("topic");
  expect(movedDocumentPath(movePlan, "archive/topic")).toBe(
    "archive/topic/README.md",
  );
});

test("bare folder move plan moves the folder directly", () => {
  const tree = sampleTree();
  const drag = prepareTreeDrag(tree, "assets", afterIntoArchive());

  expect(drag?.fromParent).toBe("");
  expect(drag?.toParent).toBe("archive");

  const movePlan = buildCrossParentMovePlan(tree, drag!);
  expect(movePlan.isBareFolder).toBe(true);
  expect(movePlan.isDocFolder).toBe(false);
  expect(movePlan.movePath).toBe("assets");
  expect(movedDocumentPath(movePlan, "archive/assets")).toBe("archive/assets");
});

test("collection move plan moves the collection directory, not README", () => {
  const tree = sampleTree();
  const drag = prepareTreeDrag(tree, "tasks/README.md", afterIntoArchive());

  expect(drag?.fromParent).toBe("");
  expect(drag?.toParent).toBe("archive");

  const movePlan = buildCrossParentMovePlan(tree, drag!);
  expect(movePlan.isBareFolder).toBe(false);
  expect(movePlan.isDocFolder).toBe(true);
  expect(movePlan.movePath).toBe("tasks");
  expect(movedDocumentPath(movePlan, "archive/tasks")).toBe(
    "archive/tasks/README.md",
  );
});

test("cross-parent move order inserts before the projected target child", () => {
  const order = buildCrossParentMoveOrder({
    currentTree: movedNoteIntoArchiveTree(),
    movedNodeName: "note.md",
    parentPath: "archive",
    projection: {
      depth: 1,
      parentPath: "archive",
      type: "before",
      overPath: "archive/b.md",
    },
  });

  expect(order?.archive).toEqual(["a.md", "note.md", "b.md"]);
});

test("cross-parent move order inserts first when projected after the parent row", () => {
  const order = buildCrossParentMoveOrder({
    currentTree: movedNoteIntoArchiveTree(),
    movedNodeName: "note.md",
    parentPath: "archive",
    projection: {
      depth: 1,
      parentPath: "archive",
      type: "after",
      overPath: "archive/README.md",
    },
  });

  expect(order?.archive).toEqual(["note.md", "a.md", "b.md"]);
});

test("same-parent reorder supports the first child projection after parent row", () => {
  const order = buildSameParentReorderOrder({
    currentTree: movedNoteIntoArchiveTree(["a.md", "b.md", "note.md"]),
    fromNodeName: "note.md",
    parentPath: "archive",
    projection: {
      depth: 1,
      parentPath: "archive",
      type: "after",
      overPath: "archive/README.md",
    },
  });

  expect(order?.archive).toEqual(["note.md", "a.md", "b.md"]);
});

test("child nest conversion skips folder-like collection targets", () => {
  const tree = sampleTree();

  expect(
    getChildNestConversionPlan(tree, {
      depth: 1,
      parentPath: "tasks",
      type: "child",
      overPath: "tasks/README.md",
    }),
  ).toBeNull();

  expect(
    getChildNestConversionPlan(tree, {
      depth: 1,
      parentPath: "note",
      type: "child",
      overPath: "note.md",
    }),
  ).toEqual({
    targetPath: "note.md",
    oldName: "note.md",
    newName: "note",
  });
});

function afterIntoArchive(): Projection {
  return {
    depth: 1,
    parentPath: "archive",
    type: "after",
    overPath: "archive/README.md",
  };
}

function sampleTree(): TreeNode[] {
  return [
    doc("note.md", "note.md"),
    folder("topic", "topic/README.md", [doc("child.md", "topic/child.md")]),
    bareFolder("assets"),
    collection("tasks", "tasks/README.md"),
    folder("archive", "archive/README.md", []),
  ];
}

function movedNoteIntoArchiveTree(
  childNames: string[] = ["a.md", "b.md", "note.md"],
): TreeNode[] {
  return [
    folder(
      "archive",
      "archive/README.md",
      childNames.map((name) => doc(name, `archive/${name}`)),
    ),
  ];
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

function bareFolder(path: string): TreeNode {
  return {
    name: path,
    path,
    title: path,
    icon: null,
    has_changes: false,
    has_schema: false,
    hasChildren: false,
    kind: "folder",
    children: [],
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
