import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Module mocks stay for the whole process, so the scenarios run in their own.
if (process.env.SVODE_TREE_ITEM_CREATE_PROCESS !== "1") {
  test("tree item creation refusals", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TREE_ITEM_CREATE_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest;
  const { setLocale } = await import("@/paraglide/runtime.js");
  const toastErrors: unknown[] = [];
  let refusal: unknown = null;
  const refuse = async () => {
    throw refusal;
  };
  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toastErrors.push(message),
      success: () => undefined,
      warning: () => undefined,
    },
  }));
  const actions = await import("../api/content-tree-actions");
  mock.module("../api/content-tree-actions", () => ({
    ...actions,
    convertTreeBareFolderToCollection: refuse,
    convertTreePageToCollection: refuse,
    createTreeFolder: refuse,
    createTreePage: refuse,
    createBareFolderPage: refuse,
    resolveTreeChildTarget: async () => ({
      parentPath: null,
      parentNodePath: "",
    }),
  }));
  // The hook keeps no React state, so the handlers run outside a render.
  const { useFileTreeItemCreate: fileTreeItemCreate } =
    await import("./use-file-tree-item-create");
  type Input = Parameters<typeof fileTreeItemCreate>[0];
  type TreeNode = Input["node"];
  type SpaceInfo = NonNullable<Input["space"]>;

  const space = { id: "docs", name: "Docs", path: "/project/docs" };
  function creation(node: Partial<TreeNode> = {}) {
    return fileTreeItemCreate({
      node: {
        name: "Items.md",
        path: "Items.md",
        title: "Items",
        icon: null,
        has_changes: false,
        has_schema: false,
        ...node,
      } as TreeNode,
      spaceId: space.id,
      space: space as SpaceInfo,
      bareFolder: false,
      activeRootPath: "/project",
      openPage: () => undefined,
      openCollectionOwner: () => undefined,
      reloadTreeParent: async () => undefined,
      reloadTreePathParent: async () => undefined,
      reloadTreePathParents: async () => undefined,
      removeTreePath: () => undefined,
      toggleExpanded: () => undefined,
    });
  }
  const takenName = (path: string) => ({
    kind: "file_already_exists",
    message: `File already exists: ${path}`,
    path,
  });
  const silenceConsole = () => {
    const error = console.error;
    console.error = () => undefined;
    return () => {
      console.error = error;
    };
  };

  test("New folder in the Space root names the taken name and the Space", async () => {
    const restore = silenceConsole();
    try {
      await setLocale("en", { reload: false });
      toastErrors.length = 0;
      refusal = takenName("New folder");
      await creation().handleNewFolder();
      await setLocale("ru", { reload: false });
      refusal = takenName("Новая папка");
      await creation().handleNewFolder();
    } finally {
      restore();
    }
    expect(toastErrors).toEqual([
      "“New folder” is already taken in “Docs”.",
      "Имя «Новая папка» уже занято в «Docs».",
    ]);
  });

  test("Make collection names the taken folder of the page", async () => {
    const restore = silenceConsole();
    try {
      await setLocale("en", { reload: false });
      toastErrors.length = 0;
      refusal = takenName("Notes/items");
      await creation({ path: "Notes/Items.md" }).handleMakeCollection();
    } finally {
      restore();
    }
    expect(toastErrors).toEqual(["“items” is already taken in “Notes”."]);
  });

  test("other refusals keep the generic text", async () => {
    const restore = silenceConsole();
    try {
      await setLocale("en", { reload: false });
      toastErrors.length = 0;
      refusal = "IO error: denied";
      await creation().handleNewFolder();
      refusal = { kind: "source_busy", path: "Items.md" };
      await creation().handleMakeCollection();
    } finally {
      restore();
    }
    expect(toastErrors).toEqual([
      "Something went wrong",
      "Something went wrong",
    ]);
  });
}
