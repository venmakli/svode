import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

import type { SpaceInfo, TreeNode } from "../model/types";

// The toasts of a refused rename are read from a mocked `sonner`, loaded
// first; module mocks stay for the whole process, so it runs in its own.
if (process.env.SVODE_TREE_ITEM_RENAME_DOM !== "1") {
  test("tree item rename refusal DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TREE_ITEM_RENAME_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest;
  const toastErrors: unknown[] = [];
  mock.module("sonner", () => ({
    toast: Object.assign(() => undefined, {
      error: (message: unknown) => toastErrors.push(message),
      info: () => undefined,
      success: () => undefined,
      warning: () => undefined,
    }),
  }));
  const { setLocale } = await import("@/paraglide/runtime.js");
  const { useFileTreeItemRename } = await import("./use-file-tree-item-rename");
  const { useSpaceStore } = await import("../model/space-store");

  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
  const spacePath = "/rename-refusal";
  const space: SpaceInfo = {
    description: "",
    hasSchema: false,
    hasSpaces: false,
    icon: "",
    id: "root",
    lastOpened: null,
    lfsState: "n/a",
    name: "Root",
    path: spacePath,
    status: "ready",
  };

  function row(path: string, kind: "folder" | "page"): TreeNode {
    const name = path.split("/").pop()!;
    return {
      children: [],
      has_changes: false,
      has_schema: false,
      hasChildren: false,
      icon: null,
      kind,
      name,
      path,
      title: name.replace(/\.md$/, ""),
    };
  }

  /** What the next rename by path or by title fails with. */
  let refusal: unknown = null;
  const commands: string[] = [];

  async function rename(input: {
    path: string;
    bareFolder: boolean;
    name: string;
  }) {
    toastErrors.length = 0;
    commands.length = 0;
    const dom = await createTestDom();
    mockNativeIpc(async (command) => {
      commands.push(command);
      if (command === "rename_content" || command === "update_page_field") {
        throw refusal;
      }
      return null;
    });
    useSpaceStore.setState({
      activeRootId: "root",
      activeRootPath: spacePath,
      rootSpaces: [space],
    });
    const state: { current?: ReturnType<typeof useFileTreeItemRename> } = {};
    const node = row(input.path, input.bareFolder ? "folder" : "page");
    function Row() {
      const actions = useFileTreeItemRename({
        activeRootPath: spacePath,
        bareFolder: input.bareFolder,
        node,
        patchPageTreeMeta: () => undefined,
        reloadTreeParents: async () => undefined,
        removeTreePath: () => undefined,
        space,
        spaceId: "root",
      });
      useEffect(() => {
        state.current = actions;
      });
      return null;
    }
    try {
      await dom.render(<Row />);
      await act(async () => {
        state.current!.handleStartRename();
        await turn();
      });
      await act(async () => {
        state.current!.setEditValue(input.name);
        await turn();
      });
      await act(async () => {
        await state.current!.handleRenameSubmit();
        await turn();
      });
      return {
        commands: [...commands],
        isEditing: state.current!.isEditing,
        renameConflictPath: state.current!.renameConflictPath,
        toasts: [...toastErrors],
      };
    } finally {
      clearNativeMocks();
      await dom.dispose();
    }
  }

  const folder = { path: "lists/tasks", bareFolder: true, name: "todo" };
  const page = { path: "lists/Plan.md", bareFolder: false, name: "Roadmap" };

  test("a rename by path to a taken name names the name and the folder", async () => {
    await setLocale("en", { reload: false });
    refusal = {
      kind: "file_already_exists",
      message: "File already exists: lists/todo",
      path: "lists/todo",
    };
    const result = await rename(folder);
    expect(result.commands).toEqual(["rename_content"]);
    expect(result.toasts).toEqual(["“todo” is already taken in “lists”."]);
    // The row leaves editing with its old name.
    expect(result.isEditing).toBe(false);
    expect(result.renameConflictPath).toBeNull();

    await setLocale("ru", { reload: false });
    expect((await rename(folder)).toasts).toEqual([
      "Имя «todo» уже занято в «lists».",
    ]);
  });

  test("a rename to the name of a child Space root names it as taken", async () => {
    await setLocale("en", { reload: false });
    refusal = {
      kind: "path_in_other_space",
      message: "eng belongs to Space eng; run the operation in that Space",
      path: "eng",
      spaceId: "eng",
    };
    const result = await rename({
      path: "tasks",
      bareFolder: true,
      name: "eng",
    });
    expect(result.toasts).toEqual(["“eng” is already taken in “Root”."]);
    expect(result.isEditing).toBe(false);

    await setLocale("ru", { reload: false });
    expect(
      (await rename({ path: "tasks", bareFolder: true, name: "eng" })).toasts,
    ).toEqual(["Имя «eng» уже занято в «Root»."]);
  });

  test("a rename by title to a name taken on disk names it too", async () => {
    await setLocale("en", { reload: false });
    refusal = {
      kind: "file_already_exists",
      message: "File already exists: lists/Roadmap.md",
      path: "lists/Roadmap.md",
    };
    const result = await rename(page);
    expect(result.commands).toEqual(["update_page_field"]);
    expect(result.toasts).toEqual([
      "“Roadmap.md” is already taken in “lists”.",
    ]);
    expect(result.isEditing).toBe(false);
  });

  test("a Page name conflict stays inline without a toast", async () => {
    refusal = {
      kind: "page_name_conflict",
      conflict: {
        parentPath: "lists",
        conflicts: [{ path: "lists/Roadmap.md", title: "Roadmap" }],
      },
    };
    const result = await rename(page);
    expect(result.toasts).toEqual([]);
    expect(result.isEditing).toBe(true);
    expect(result.renameConflictPath).toBe("lists/Roadmap.md");
  });

  test("other refusals show the general text", async () => {
    await setLocale("en", { reload: false });
    for (const [input, error] of [
      [folder, { kind: "io", message: "Permission denied" }],
      [
        folder,
        {
          kind: "title_rename_required",
          message: "lists/tasks is a Collection: rename it by its title",
          path: "lists/tasks",
        },
      ],
      [
        folder,
        {
          kind: "unsupported_rename_target",
          message: "lists/tasks cannot be renamed",
          path: "lists/tasks",
        },
      ],
      [page, "Failed to write the Page"],
    ] as const) {
      refusal = error;
      const result = await rename(input);
      expect(result.toasts).toEqual(["Something went wrong"]);
      expect(result.isEditing).toBe(false);
    }
    await setLocale("ru", { reload: false });
    refusal = { kind: "io", message: "Permission denied" };
    expect((await rename(folder)).toasts).toEqual(["Что-то пошло не так"]);
  });
}
