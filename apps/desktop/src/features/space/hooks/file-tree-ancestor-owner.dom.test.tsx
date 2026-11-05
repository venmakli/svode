import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { SpaceInfo, TreeNode } from "../model/types";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/** How the main area holds an open App or Collection at the folder `path`. */
const owners = {
  "an App without README": {
    readme: false,
    open: (path: string) => ({ owner: "app-directory", path }) as const,
  },
  "a Collection without README": {
    readme: false,
    open: (path: string) => ({ owner: "collection", path }) as const,
  },
  "a Collection with README opened from the sidebar": {
    readme: true,
    open: (path: string) =>
      ({ owner: "collection", path: `${path}/README.md` }) as const,
  },
  "a Collection with README opened by its folder": {
    readme: true,
    open: (path: string) => ({ owner: "collection", path }) as const,
  },
  "an App with README opened as its README": {
    readme: true,
    open: (path: string) =>
      ({ owner: "page", path: `${path}/README.md` }) as const,
  },
} as const;

type Opening = ReturnType<(typeof owners)[keyof typeof owners]["open"]>;

/**
 * An App or Collection open in the main area at `opening`, with the README
 * session of its home page when it has one, and the sidebar operations over
 * the Space: `docs` is a bare folder and a folder Page.
 */
async function environment(opening: Opening, readme: boolean) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  const spacePath = `/ancestor-owner-${Math.random()}`;
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
  const folderOf = (path: string) => path.replace(/\/README\.md$/, "");
  const files = new Set(["docs/README.md"]);
  if (readme) files.add(`${folderOf(opening.path)}/README.md`);
  const relocate = (from: string, to: string) => {
    for (const path of [...files])
      if (path.startsWith(`${from}/`)) {
        files.delete(path);
        files.add(`${to}${path.slice(from.length)}`);
      }
  };
  let failure: string | null = null;
  let reads = 0;
  // What the main area showed when the operations over the Space finished.
  const shownWhenSettled: (string | null)[] = [];
  const store: {
    current?: typeof import("../model/space-store").useSpaceStore;
  } = {};
  const leave = (from: string, to: string) => {
    void store
      .current!.getState()
      .treePathMutationsSettled(spacePath)
      .then(() => shownWhenSettled.push(selected()));
    if (failure) throw failure;
    relocate(from, to);
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
          meta: { title: path, icon: null, created: "", updated: "" },
        };
      }
      if (command === "rename_content") {
        leave(String(input.from), String(input.to));
        return [];
      }
      if (command === "move_content") {
        const to = `${String(input.toParent)}/${String(input.from).split("/").pop()}`;
        leave(String(input.from), to);
        return { newPath: to, convertedParents: [] };
      }
      if (command === "update_page_field") {
        const from = String(input.filePath).replace(/\/README\.md$/, "");
        const to = String(input.value);
        leave(from, to);
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
  store.current = useSpaceStore;
  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: spacePath,
    rootSpaces: [space],
  });
  const { PageDetailProvider, usePageDetailContext } =
    await import("@/features/page/scope-surface");
  const artifact = await import("@/features/artifact");
  const { openPage } = await import("@/features/page/navigation");
  const { useFileTreeItemRename } = await import("./use-file-tree-item-rename");
  const { useFileTreeDragCommand } =
    await import("./use-file-tree-drag-command");
  const { useAgentContentRelocation } =
    await import("./use-agent-content-relocation");
  function selected() {
    return artifact.getActiveContentPath();
  }
  let readmeShown: string | null = null;
  function Shown() {
    const path = usePageDetailContext().page?.path ?? null;
    useEffect(() => {
      readmeShown = path;
    });
    return null;
  }
  // The shell shows the README of the owner at the selected path.
  function Home() {
    const path = artifact.useActiveContentPath();
    if (!path || !readme) return null;
    const ownerPath = folderOf(path);
    return (
      <PageDetailProvider
        spacePath={spacePath}
        spaceId="root"
        readmePath={`${ownerPath}/README.md`}
        ownerPath={ownerPath}
        target="readme"
        onOpenPath={() => {}}
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
  function Listener() {
    useAgentContentRelocation();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  artifact.closeActiveContent();
  if (opening.owner === "page") openPage(opening.path, "root");
  else
    artifact.openScopeOwner({
      kind: opening.owner,
      path: opening.path,
      spaceId: "root",
    });
  const { emit } = await import("@/platform/native/events");
  return {
    files,
    reads: () => reads,
    shownWhenSettled,
    /** The path the selection holds and the README its home page shows. */
    opened: () => ({ selection: selected(), readme: readmeShown }),
    /** The kind and request of the selection, kept by a retarget. */
    request: () => {
      const { selection } = artifact.getActiveContentSelection();
      return selection
        ? `${selection.kind}:${
            selection.kind === "artifact"
              ? selection.request.sessionKey
              : selection.request.key
          }`
        : null;
    },
    render: async (row: TreeNode) => {
      await act(async () => {
        root.render(
          <>
            <Home />
            <Sidebar row={row} />
            <Listener />
          </>,
        );
        await turn();
        await turn();
      });
    },
    fail: (message: string) => {
      failure = message;
    },
    rename: async (name: string) => {
      await act(async () => {
        actions.rename!.handleStartRename();
        await turn();
      });
      await act(async () => {
        actions.rename!.setEditValue(name);
        await turn();
      });
      await act(async () => {
        await actions.rename!.handleRenameSubmit();
        await turn();
        await turn();
      });
    },
    drag: async (fromPath: string) => {
      await act(async () => {
        await actions.drag!({
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
    },
    /** An agent moves `from` to `to` through Svode MCP. */
    agentMove: async (from: string, to: string) => {
      await act(async () => {
        await emit("content:relocation", {
          space: spacePath,
          phase: "started",
        });
        await turn();
        relocate(from, to);
        await emit("content:relocation", {
          space: spacePath,
          phase: "finished",
          relocations: [{ from, to, converted: false }],
        });
        for (let index = 0; index < 4; index += 1) await turn();
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      artifact.closeActiveContent();
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

const operations = {
  "renaming the folder above": {
    row: node("docs", "folder"),
    run: (env: Awaited<ReturnType<typeof environment>>) => env.rename("notes"),
    to: "notes",
  },
  "renaming the folder Page above by its title": {
    row: node("docs/README.md", "page"),
    run: (env: Awaited<ReturnType<typeof environment>>) => env.rename("notes"),
    to: "notes",
  },
  "dragging the folder above into another": {
    row: node("docs", "folder"),
    run: (env: Awaited<ReturnType<typeof environment>>) => env.drag("docs"),
    to: "archive/docs",
  },
} as const;

for (const [name, operation] of Object.entries(operations)) {
  for (const [ownerName, owner] of Object.entries(owners)) {
    for (const folder of ["docs/tool", "docs/sub/tool"]) {
      const movedFolder = `${operation.to}${folder.slice("docs".length)}`;
      const opening = owner.open(folder);
      const moved = `${operation.to}${opening.path.slice("docs".length)}`;
      test(`${name} takes ${ownerName} at ${folder} to ${movedFolder} with its session, without a watcher event`, async () => {
        const env = await environment(opening, owner.readme);
        try {
          await env.render(operation.row);
          const request = env.request();
          const reads = env.reads();
          expect(env.opened()).toEqual({
            selection: opening.path,
            readme: owner.readme ? `${folder}/README.md` : null,
          });
          await operation.run(env);
          // The selection moves rather than opens anew, and the README
          // session goes on at its new path without reading it again.
          expect(env.opened()).toEqual({
            selection: moved,
            readme: owner.readme ? `${movedFolder}/README.md` : null,
          });
          expect(env.request()).toBe(request);
          expect(env.reads()).toBe(reads);
          if (owner.readme)
            expect(env.files.has(`${movedFolder}/README.md`)).toBe(true);
          // The operation counts as finished once the owner moved with it.
          expect(env.shownWhenSettled).toEqual([moved]);
        } finally {
          await env.cleanup();
        }
      });
    }
  }
}

for (const opening of [
  { owner: "app-directory", path: "docs-old/tool" },
  { owner: "collection", path: "other/tool/README.md" },
] as const) {
  test(`renaming the folder docs leaves the owner at ${opening.path} where it is`, async () => {
    const env = await environment(opening, opening.owner === "collection");
    try {
      await env.render(node("docs", "folder"));
      const before = env.opened();
      const reads = env.reads();
      await env.rename("notes");
      expect(env.opened()).toEqual(before);
      expect(env.reads()).toBe(reads);
    } finally {
      await env.cleanup();
    }
  });
}

for (const [name, row] of [
  ["renaming the folder above", node("docs", "folder")],
  [
    "renaming the folder Page above by its title",
    node("docs/README.md", "page"),
  ],
] as const) {
  test(`${name} that fails leaves the open owner inside where it is`, async () => {
    const opening = {
      owner: "collection",
      path: "docs/tool/README.md",
    } as const;
    const env = await environment(opening, true);
    try {
      await env.render(row);
      env.fail("Name taken");
      await env.rename("notes");
      expect(env.opened()).toEqual({
        selection: "docs/tool/README.md",
        readme: "docs/tool/README.md",
      });
      expect(env.files.has("docs/tool/README.md")).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
}

test("a folder above an open owner moved by an agent does not move its home page with it", async () => {
  for (const opening of [
    { owner: "app-directory", path: "docs/tool" },
    { owner: "collection", path: "docs/tool/README.md" },
  ] as const) {
    const env = await environment(opening, opening.owner === "collection");
    try {
      await env.render(node("archive", "folder"));
      const before = env.opened();
      await env.agentMove("docs", "archive/docs");
      // Only the sidebar of this Desktop takes the home page along; the
      // owner left at the old path closes as a vanished one.
      expect(env.opened()).toEqual(before);
    } finally {
      await env.cleanup();
    }
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
