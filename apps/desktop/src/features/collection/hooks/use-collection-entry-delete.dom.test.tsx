import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";

if (process.env.SVODE_COLLECTION_ENTRY_DELETE_DOM !== "1") {
  test("Collection row and Peek delete DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ENTRY_DELETE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    FocusEvent: dom.window.FocusEvent,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const commands: [string, Record<string, unknown>][] = [];
  let backlinks: unknown[] = [];
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => 0,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        commands.push([command, args]);
        if (command === "get_backlinks") return backlinks;
        if (command === "list_tree_children") return [];
        if (command === "get_page_detail_state")
          return { form: "folder", subpageCount: 2, otherFileCount: 1 };
        return null;
      },
    },
  });

  // Deletions this Desktop runs must be known to open Pages they remove.
  const deleted: [string, string][] = [];
  mock.module("@/features/page/model/own-path-change", () => ({
    trackOwnContentDeletion: async (
      target: { spacePath: string; path: string },
      run: () => Promise<unknown>,
    ) => {
      const result = await run();
      const call = commands.at(-1);
      if (call?.[0] === "delete_content" && call[1].path === target.path) {
        deleted.push([target.path, target.spacePath]);
      }
      return result;
    },
    trackOwnContentRelocation: (
      _target: unknown,
      run: () => Promise<unknown>,
    ) => run(),
    followOwnContentRelocation: () => {},
    ownChangeRoot: (path: string) => path,
    watchOwnPathChange: () => ({ changedHere: () => false, stop: () => {} }),
  }));

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { ContentDeleteDialog } = await import("@/features/content-actions");
  const { useCollectionEntryDelete } =
    await import("./use-collection-entry-delete");
  const { useCollectionEntryActions } =
    await import("./use-collection-entry-actions");
  type EntryDelete = ReturnType<typeof useCollectionEntryDelete>;

  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  let entryDelete: EntryDelete | null = null;

  function Harness({ readOnly }: { readOnly: boolean }) {
    // The real row deletion of the Collection, as its screen wires it.
    const { deleteRow } = useCollectionEntryActions({
      schema: null,
      spacePath: "/project/docs",
      projectPath: "/project",
      collectionPath: "tasks",
      spaceId: "docs",
      openPage: () => {},
    });
    const current = useCollectionEntryDelete({
      readOnly,
      spacePath: "/project/docs",
      projectPath: "/project",
      deleteRow,
    });
    useEffect(() => {
      entryDelete = current;
    });
    return <ContentDeleteDialog {...current.dialog} />;
  }

  async function render(readOnly = false) {
    await act(async () => root.render(<Harness readOnly={readOnly} />));
  }

  const page = (path: string, title: string): Page => ({
    path,
    body: "",
    meta: { title, icon: null, created: "", updated: "", extra: {} },
  });

  async function request(run: (current: EntryDelete) => void) {
    await act(async () => run(entryDelete!));
    await settle();
  }

  function deleteDialog() {
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!dialog) return null;
    return {
      title: dialog.querySelector('[data-slot="alert-dialog-title"]')
        ?.textContent,
      description: dialog.querySelector(
        '[data-slot="alert-dialog-description"]',
      )?.textContent,
      backlinks: [
        ...dialog.querySelectorAll("[data-content-delete-backlinks] li"),
      ].map((item) => item.textContent),
    };
  }

  async function clickDialogButton(label: string) {
    const button = [
      ...document.querySelectorAll('[role="alertdialog"] button'),
    ].find((element) => element.textContent === label) as
      | HTMLElement
      | undefined;
    if (!button) throw new Error(`no dialog button ${label}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Radix finishes closing the dialog after its own state update.
    await settle();
  }

  test("a row confirms deleting its Collection item with its links", async () => {
    await render();
    backlinks = [{ sourceSpaceId: null, sourcePath: "plan.md", linkCount: 1 }];
    await request((current) =>
      current.requestRowDelete(page("tasks/Task.md", "Task")),
    );
    expect(deleteDialog()).toEqual({
      title: "Delete collection item?",
      description: "The collection item “Task” will be deleted.",
      backlinks: ["plan.md"],
    });
    expect(
      commands.filter(([command]) => command === "get_backlinks").at(-1)?.[1],
    ).toEqual({
      space: "/project/docs",
      targetPath: "tasks/Task.md",
      projectPath: "/project",
    });
    await clickDialogButton("Cancel");
    expect(deleteDialog()).toBeNull();
    expect(deleted).toEqual([]);

    backlinks = [];
    await request((current) =>
      current.requestRowDelete(page("tasks/Epic/README.md", "Epic")),
    );
    expect(deleteDialog()).toEqual({
      title: "Delete collection item?",
      description:
        "The collection item “Epic” will be deleted with its nested pages and files.",
      backlinks: [],
    });
    await clickDialogButton("Delete");
    expect(deleteDialog()).toBeNull();
    expect(deleted).toEqual([["tasks/Epic/README.md", "/project/docs"]]);
  });

  test("a Peek deletes its item or template where it lives, also in a read-only Collection", async () => {
    deleted.length = 0;
    await render(true);
    commands.length = 0;
    await request((current) =>
      current.requestRowDelete(page("tasks/Task.md", "Task")),
    );
    expect(deleteDialog()).toBeNull();
    expect(commands).toEqual([]);

    const target = {
      spacePath: "/project/other",
      projectPath: "/project",
      spaceId: "other",
    };
    await request((current) =>
      current.requestPeekDelete(
        page(".svode/templates/tasks/Bug.md", "Bug"),
        target,
        { slug: "bug", collectionPath: "tasks", isDefault: true },
      ),
    );
    expect(deleteDialog()).toEqual({
      title: "Delete template?",
      description: "The template “Bug” will be deleted.",
      backlinks: [],
    });
    expect(
      commands.filter(([command]) => command === "get_backlinks").at(-1)?.[1]
        .space,
    ).toBe("/project/other");
    await clickDialogButton("Delete");
    expect(deleted).toEqual([
      [".svode/templates/tasks/Bug.md", "/project/other"],
    ]);

    await request((current) =>
      current.requestPeekDelete(page("tasks/Task.md", "Task"), target),
    );
    expect(deleteDialog()?.title).toBe("Delete collection item?");
    await clickDialogButton("Cancel");
    expect(deleted.length).toBe(1);
    await act(async () => root.unmount());
  });
}
