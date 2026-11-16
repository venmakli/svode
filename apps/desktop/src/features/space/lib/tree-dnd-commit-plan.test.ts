import { expect, test } from "bun:test";
import type { TreeNode } from "../model/types";
import type { Projection } from "./tree-dnd-utilities";
import {
  buildCrossParentMovePlan,
  buildCrossParentMoveOrder,
  buildSameParentReorderOrder,
  movedPagePath,
  prepareTreeDrag,
} from "./tree-dnd-commit-plan";

test("leaf Page move plan moves the Markdown file itself", () => {
  const tree = sampleTree();
  const drag = prepareTreeDrag(tree, "note.md", afterIntoArchive());

  expect(drag?.fromParent).toBe("");
  expect(drag?.toParent).toBe("archive");

  const movePlan = buildCrossParentMovePlan(tree, drag!);
  expect(movePlan.isBareFolder).toBe(false);
  expect(movePlan.isDocFolder).toBe(false);
  expect(movePlan.movePath).toBe("note.md");
  expect(movedPagePath(movePlan, "archive/note.md")).toBe("archive/note.md");
});

test("Page folder move plan moves the directory and reopens README", () => {
  const tree = sampleTree();
  const drag = prepareTreeDrag(tree, "topic/README.md", afterIntoArchive());

  expect(drag?.fromParent).toBe("");
  expect(drag?.toParent).toBe("archive");

  const movePlan = buildCrossParentMovePlan(tree, drag!);
  expect(movePlan.isBareFolder).toBe(false);
  expect(movePlan.isDocFolder).toBe(true);
  expect(movePlan.movePath).toBe("topic");
  expect(movedPagePath(movePlan, "archive/topic")).toBe(
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
  expect(movedPagePath(movePlan, "archive/assets")).toBe("archive/assets");
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
  expect(movedPagePath(movePlan, "archive/tasks")).toBe(
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

  expect(order).toEqual({ archive: ["a.md", "note.md", "b.md"] });
});

test("cross-parent move into a collapsed folder writes no order", () => {
  const order = buildCrossParentMoveOrder({
    currentTree: [
      doc("note.md", "note.md"),
      collapsedFolder("ideas", "ideas/README.md"),
    ],
    movedNodeName: "note.md",
    parentPath: "ideas",
    projection: {
      depth: 1,
      parentPath: "ideas",
      type: "child",
      overPath: "ideas/README.md",
    },
  });

  expect(order).toBeNull();
});

test("cross-parent move into a leaf Page that became a folder writes no order", () => {
  const order = buildCrossParentMoveOrder({
    currentTree: [
      doc("a.md", "a.md"),
      collapsedFolder("target", "target/README.md"),
    ],
    movedNodeName: "note.md",
    parentPath: "target",
    projection: {
      depth: 1,
      parentPath: "target",
      type: "child",
      overPath: "target.md",
    },
  });

  expect(order).toBeNull();
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

  expect(order).toEqual({ archive: ["note.md", "a.md", "b.md"] });
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

  expect(order).toEqual({ archive: ["note.md", "a.md", "b.md"] });
});

test("same-parent reorder at the root writes only the root section beside collapsed folders and Collections", () => {
  const order = buildSameParentReorderOrder({
    currentTree: [
      doc("a.md", "a.md"),
      collapsedFolder("ideas", "ideas/README.md"),
      collapsedCollection("tasks", "tasks/README.md"),
      folder("archive", "archive/README.md", [
        doc("x.md", "archive/x.md"),
        doc("y.md", "archive/y.md"),
      ]),
      doc("note.md", "note.md"),
    ],
    fromNodeName: "note.md",
    parentPath: "",
    projection: {
      depth: 0,
      parentPath: "",
      type: "before",
      overPath: "a.md",
    },
  });

  expect(order).toEqual({
    ".": ["note.md", "a.md", "ideas", "tasks", "archive"],
  });
});

test("same-parent reorder in a nested folder writes only that folder section", () => {
  const order = buildSameParentReorderOrder({
    currentTree: [
      collapsedFolder("ideas", "ideas/README.md"),
      folder("archive", "archive/README.md", [
        doc("a.md", "archive/a.md"),
        doc("b.md", "archive/b.md"),
        doc("note.md", "archive/note.md"),
      ]),
      collapsedCollection("tasks", "tasks/README.md"),
    ],
    fromNodeName: "note.md",
    parentPath: "archive",
    projection: {
      depth: 1,
      parentPath: "archive",
      type: "before",
      overPath: "archive/b.md",
    },
  });

  expect(order).toEqual({ archive: ["a.md", "note.md", "b.md"] });
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

function collapsedFolder(name: string, path: string): TreeNode {
  return { ...folder(name, path, []), hasChildren: true };
}

function collapsedCollection(name: string, path: string): TreeNode {
  return { ...collection(name, path), hasChildren: true };
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
