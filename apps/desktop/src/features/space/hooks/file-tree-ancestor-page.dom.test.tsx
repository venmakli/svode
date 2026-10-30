import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { SpaceInfo, TreeNode } from "../model/types";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const PAGE = "docs/sub/a.md";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function node(path: string, kind: TreeNode["kind"]): TreeNode {
  const name = path.split("/").pop()!;
  return {
    children: [],
    has_changes: false,
    has_schema: false,
    icon: null,
    kind,
    name,
    path,
    title: name === "README.md" ? path.split("/").at(-2)! : name,
  };
}

/**
 * A Page open at `page`, with the sidebar operations over the Space. Each
 * operation that leaves a path holds until `release`, and the watcher may
 * report the old folder while it runs.
 */
async function environment(page = PAGE) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  const shown: { message: string; description?: string }[] = [];
  const saved = { error: toast.error, warning: toast.warning };
  const record = (message: unknown, data?: { description?: unknown }) => {
    shown.push({
      message: String(message),
      ...(data?.description ? { description: String(data.description) } : {}),
    });
    return 0;
  };
  toast.error = record as never;
  toast.warning = record as never;
  const spacePath = `/ancestor-page-${Math.random()}`;
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
  const files = new Set([page, "docs/README.md"]);
  const relocate = (from: string, to: string) => {
    for (const path of [...files])
      if (path.startsWith(`${from}/`)) {
        files.delete(path);
        files.add(`${to}${path.slice(from.length)}`);
      }
  };
  let operation = Promise.resolve();
  let reportDuring: string | null = null;
  let failure: string | null = null;
  let reads = 0;
  const { emit } = await import("@/platform/native/events");
  const leave = async (from: string, to: string) => {
    if (failure) {
      await operation;
      throw failure;
    }
    relocate(from, to);
    if (reportDuring)
      await emit("file:created", { space: spacePath, path: reportDuring });
    await operation;
  };
  mockNativeIpc(
    async (command, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      if (command === "read_page") {
        reads += 1;
        const path = String(input.path);
        if (!files.has(path)) throw `File not found: ${path}`;
        return {
          path,
          body: "",
          meta: { title: "A", icon: null, created: "", updated: "" },
        };
      }
      if (command === "rename_content") {
        await leave(String(input.from), String(input.to));
        return [];
      }
      if (command === "move_content") {
        const to = `${String(input.toParent)}/${String(input.from).split("/").pop()}`;
        await leave(String(input.from), to);
        return to;
      }
      if (command === "update_page_field") {
        const from = String(input.filePath).replace(/\/README\.md$/, "");
        const to = String(input.value);
        await leave(from, to);
        return {
          path: `${to}/README.md`,
          body: "",
          meta: { title: to, icon: null, created: "", updated: "" },
        };
      }
      if (command === "list_tree_children") return [];
      if (command === "navigation_expanded_paths") return [];
      return null;
    },
    { shouldMockEvents: true },
  );
  const { createRoot } = await import("react-dom/client");
  const { useSpaceStore } = await import("../model/space-store");
  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: spacePath,
    rootSpaces: [space],
  });
  const { PageDetailProvider, usePageDetailContext } =
    await import("@/features/page/scope-surface");
  const { closeActiveContent, getActiveContentPath, useActiveContentPath } =
    await import("@/features/artifact");
  const { openPage } = await import("@/features/page/navigation");
  const { useFileTreeItemRename } = await import("./use-file-tree-item-rename");
  const { useFileTreeDragCommand } =
    await import("./use-file-tree-drag-command");
  let gone = 0;
  let shownPath: string | null = null;
  function Shown() {
    const path = usePageDetailContext().page?.path ?? null;
    useEffect(() => {
      shownPath = path;
    });
    return null;
  }
  // The shell opens the selected Page at its path.
  function OpenPage() {
    const path = useActiveContentPath();
    if (!path) return null;
    return (
      <PageDetailProvider
        spacePath={spacePath}
        spaceId="root"
        readmePath={path}
        ownerPath={path}
        target="page"
        onOpenPath={() => {}}
        onPageGone={() => (gone += 1)}
      >
        <Shown />
      </PageDetailProvider>
    );
  }
  const actions: {
    rename?: ReturnType<typeof useFileTreeItemRename>;
    drag?: ReturnType<typeof useFileTreeDragCommand>;
  } = {};
  function Sidebar({ row }: { row: TreeNode }) {
    const rename = useFileTreeItemRename({
      activeRootPath: spacePath,
      bareFolder: row.kind === "folder",
      node: row,
      patchPageTreeMeta: () => undefined,
      reloadTreeParents: async () => undefined,
      removeTreePath: () => undefined,
      siblingRows: [],
      space,
      spaceId: "root",
    });
    const drag = useFileTreeDragCommand({
      spaceId: "root",
      tree: [node("archive", "folder"), row],
    });
    useEffect(() => {
      actions.rename = rename;
      actions.drag = drag;
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  closeActiveContent();
  openPage(page, "root");
  const render = async (row: TreeNode) => {
    await act(async () => {
      root.render(
        <>
          <OpenPage />
          <Sidebar row={row} />
        </>,
      );
      await turn();
      await turn();
    });
  };
  return {
    spacePath,
    files,
    shown,
    gone: () => gone,
    reads: () => reads,
    /** The path the open Page shows and the selection holds. */
    opened: () => ({ page: shownPath, selection: getActiveContentPath() }),
    render,
    /** Makes the next operations fail once released. */
    fail: (message: string) => {
      failure = message;
    },
    /** Holds the next operations until the returned release. */
    hold: (folder: string | null) => {
      const gate = deferred();
      operation = gate.promise;
      reportDuring = folder;
      return gate.resolve;
    },
    /**
     * Starts renaming the row to `name`, as the sidebar input does; the
     * operation runs on in `done`.
     */
    rename: async (name: string) => {
      await act(async () => {
        actions.rename!.handleStartRename();
        await turn();
      });
      await act(async () => {
        actions.rename!.setEditValue(name);
        await turn();
      });
      let done!: Promise<void>;
      await act(async () => {
        done = actions.rename!.handleRenameSubmit();
        await turn();
        await turn();
      });
      return { done };
    },
    /** Starts dragging the row into `archive`; it runs on in `done`. */
    drag: async (fromPath: string) => {
      let done!: Promise<void>;
      await act(async () => {
        done = actions.drag!({
          fromPath,
          projection: {
            depth: 1,
            overPath: "archive",
            parentPath: "archive",
            type: "after",
          },
        });
        await turn();
        await turn();
      });
      return { done };
    },
    finish: async (running: { done: Promise<void> }) => {
      await act(async () => {
        await running.done;
        await turn();
        await turn();
        await turn();
      });
    },
    event: async (path: string, event = "file:created") => {
      await act(async () => {
        await emit(event, { space: spacePath, path });
        await turn();
        await turn();
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      closeActiveContent();
      Object.assign(toast, saved);
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

const operations = {
  "renaming the folder": {
    row: node("docs", "folder"),
    run: (env: Awaited<ReturnType<typeof environment>>) => env.rename("notes"),
    to: "notes",
  },
  "renaming the folder Page by its title": {
    row: node("docs/README.md", "page"),
    run: (env: Awaited<ReturnType<typeof environment>>) => env.rename("notes"),
    to: "notes",
  },
  "dragging the folder into another": {
    row: node("docs", "folder"),
    run: (env: Awaited<ReturnType<typeof environment>>) => env.drag("docs"),
    to: "archive/docs",
  },
} as const;

for (const [name, operation] of Object.entries(operations)) {
  for (const page of ["docs/a.md", PAGE]) {
    const moved = `${operation.to}${page.slice("docs".length)}`;
    test(`${name} above an open Page at ${page} takes it to ${moved} without a watcher event`, async () => {
      const env = await environment(page);
      try {
        await env.render(operation.row);
        const reads = env.reads();
        env.hold(null)();
        await env.finish(await operation.run(env));
        expect(env.opened()).toEqual({ page: moved, selection: moved });
        // The session goes on at the new path without reading the Page again.
        expect(env.reads()).toBe(reads);
        expect(env.files.has(moved)).toBe(true);
        expect(env.files.has(page)).toBe(false);
        expect(env.gone()).toBe(0);
        expect(env.shown).toEqual([]);
      } finally {
        await env.cleanup();
      }
    });
  }

  test(`${name} above an open Page confirms nothing while it runs and gives no message for the old folder reported then`, async () => {
    const env = await environment();
    try {
      await env.render(operation.row);
      const release = env.hold("docs");
      const running = await operation.run(env);
      // The Page path is gone and its folder was reported, yet the
      // operation decides once it finished.
      expect(env.files.has(PAGE)).toBe(false);
      expect(env.gone()).toBe(0);
      release();
      await env.finish(running);
      const moved = `${operation.to}/sub/a.md`;
      expect(env.opened()).toEqual({ page: moved, selection: moved });
      expect(env.gone()).toBe(0);
      expect(env.shown).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  test(`${name} above an open Page gives no message for the old folder reported after it finished`, async () => {
    const env = await environment();
    try {
      await env.render(operation.row);
      env.hold(null)();
      await env.finish(await operation.run(env));
      await env.event("docs");
      const moved = `${operation.to}/sub/a.md`;
      expect(env.opened()).toEqual({ page: moved, selection: moved });
      expect(env.gone()).toBe(0);
      expect(env.shown).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });
}

for (const [name, row] of [
  ["renaming the folder", node("docs", "folder")],
  ["renaming the folder Page by its title", node("docs/README.md", "page")],
] as const) {
  test(`${name} that fails leaves the open Page inside where it is`, async () => {
    const env = await environment();
    try {
      await env.render(row);
      env.fail("Name taken");
      env.hold(null)();
      await env.finish(await env.rename("notes"));
      expect(env.opened()).toEqual({ page: PAGE, selection: PAGE });
      expect(env.files.has(PAGE)).toBe(true);
      expect(env.gone()).toBe(0);
    } finally {
      await env.cleanup();
    }
  });
}

for (const page of ["docs-old/a.md", "other/b.md"]) {
  test(`renaming the folder docs leaves the open Page at ${page} where it is`, async () => {
    const env = await environment(page);
    try {
      await env.render(node("docs", "folder"));
      const reads = env.reads();
      env.hold(null)();
      await env.finish(await env.rename("notes"));
      expect(env.opened()).toEqual({ page, selection: page });
      expect(env.reads()).toBe(reads);
      expect(env.gone()).toBe(0);
    } finally {
      await env.cleanup();
    }
  });
}

test("another writer deleting the folder of an open Page while a folder with a longer name is renamed here gives the message", async () => {
  const env = await environment();
  try {
    await env.render(node("docs-old", "folder"));
    const release = env.hold(null);
    const running = await env.rename("archive-old");
    env.files.delete(PAGE);
    await env.event("docs", "file:deleted");
    // Nothing is confirmed while an operation over the Space runs.
    expect(env.gone()).toBe(0);
    release();
    await env.finish(running);
    expect(env.gone()).toBe(1);
    expect(env.shown).toEqual([
      {
        message: m.page_deleted_externally_title({ title: "A" }),
        description: m.page_deleted_externally_description(),
      },
    ]);
  } finally {
    await env.cleanup();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    document: dom.window.document,
    window: dom.window,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
