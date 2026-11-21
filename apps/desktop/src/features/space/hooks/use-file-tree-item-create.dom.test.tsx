import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { TreeNode } from "../model/types";

type Call = { command: string; args: Record<string, unknown> };
type Action = "handleNewPage" | "handleNewFolder";

const space = { id: "docs", name: "Docs", path: "/project/docs" };

function treeNode(path: string, node: Partial<TreeNode> = {}): TreeNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    title: "Row",
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
    ...node,
  } as TreeNode;
}

/** Runs one creation action of a tree row and reports what it did. */
async function runCreation(action: Action, node: TreeNode) {
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
    writable: true,
  });
  const saved = { error: toast.error, success: toast.success };
  const errors: unknown[] = [];
  toast.error = ((message: unknown) => errors.push(message)) as never;
  toast.success = (() => undefined) as never;
  const calls: Call[] = [];
  const removed: string[] = [];
  const expanded: string[] = [];
  const opened: string[] = [];
  mockNativeIpc(async (command, args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, args: input });
    if (command === "convert_page_to_folder") {
      const filePath = String(input.filePath);
      return {
        path: `${filePath.replace(/\.md$/, "")}/README.md`,
        body: "",
        meta: { title: "Row", icon: null, created: "", updated: "" },
      };
    }
    if (command === "create_page") {
      return {
        path: `${String(input.parentPath)}/Untitled.md`,
        body: "",
        meta: { title: "Untitled", icon: null, created: "", updated: "" },
        warnings: [],
      };
    }
    if (command === "create_folder") {
      return `${String(input.parentPath)}/New folder`;
    }
    return null;
  });
  try {
    // The hook keeps no React state, so the handlers run outside a render.
    const { useFileTreeItemCreate: fileTreeItemCreate } =
      await import("./use-file-tree-item-create");
    await fileTreeItemCreate({
      node,
      spaceId: space.id,
      space: { ...space } as never,
      bareFolder: !node.path.endsWith(".md"),
      activeRootPath: "/project",
      openPage: (path) => opened.push(path),
      openCollectionOwner: () => undefined,
      reloadTreeParent: async () => undefined,
      reloadTreePathParent: async () => undefined,
      reloadTreePathParents: async () => undefined,
      removeTreePath: (_spaceId, path) => removed.push(path),
      toggleExpanded: (_spaceId, path) => expanded.push(path),
    })[action]();
  } finally {
    clearNativeMocks();
    Object.assign(toast, saved);
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
  return {
    // Every native command of the action, so nothing else runs beside them.
    commands: calls.map((call) =>
      call.command === "convert_page_to_folder"
        ? { command: call.command, filePath: call.args.filePath }
        : { command: call.command, parentPath: call.args.parentPath },
    ),
    errors,
    removed,
    expanded,
    opened,
  };
}

for (const action of ["handleNewPage", "handleNewFolder"] as const) {
  const created = action === "handleNewPage" ? "create_page" : "create_folder";

  test(`${action} on a leaf row converts it to a folder Page and creates in its folder`, async () => {
    const result = await runCreation(action, treeNode("Notes/X.md"));

    expect(result.commands).toEqual([
      { command: "convert_page_to_folder", filePath: "Notes/X.md" },
      { command: created, parentPath: "Notes/X" },
    ]);
    expect(result.removed).toEqual(["Notes/X.md"]);
    expect(result.expanded).toEqual(["Notes/X/README.md"]);
    expect(result.opened).toEqual(
      action === "handleNewPage" ? ["Notes/X/Untitled.md"] : [],
    );
    expect(result.errors).toEqual([]);
  });

  test(`${action} on a folder Page without known children creates in its folder without a conversion`, async () => {
    const result = await runCreation(action, treeNode("Notes/Y/README.md"));

    expect(result.commands).toEqual([
      { command: created, parentPath: "Notes/Y" },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.expanded).toEqual(["Notes/Y/README.md"]);
    expect(result.errors).toEqual([]);
  });

  test(`${action} on a folder Page with children and on a bare folder keeps their folder`, async () => {
    const withChildren = await runCreation(
      action,
      treeNode("Notes/W/README.md", { hasChildren: true }),
    );
    const bare = await runCreation(action, treeNode("Notes/Z"));

    expect(withChildren.commands).toEqual([
      { command: created, parentPath: "Notes/W" },
    ]);
    expect(bare.commands).toEqual([
      { command: created, parentPath: "Notes/Z" },
    ]);
  });
}
