import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

// Module mocks and DOM globals stay for the whole process.
if (process.env.SVODE_VIRTUAL_FILE_TREE_DOM !== "1") {
  test("virtual sidebar tree DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_VIRTUAL_FILE_TREE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 120_000);
} else {
  const { mock } = bunTest;
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
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
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    DOMRect: dom.window.DOMRect,
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
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });

  // The geometry of the sidebar scroll container: 560 px high, scrollable.
  const VIEWPORT = 560;
  const scrollTops = new WeakMap<Element, number>();
  const scrollWrites: number[] = [];
  const isScroller = (element: Element) =>
    element.getAttribute("data-slot") === "sidebar-content";
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? VIEWPORT : 0;
    },
  });
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? 1_000_000 : 0;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, value);
    },
  });
  Object.defineProperty(proto, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: { top?: number }) {
      if (options.top === undefined) return;
      scrollWrites.push(options.top);
      if (this.scrollTop === options.top) return;
      this.scrollTop = options.top;
      // Browsers report a scroll after the write, not inside it.
      dom.window.requestAnimationFrame(() =>
        this.dispatchEvent(new dom.window.Event("scroll")),
      );
    },
  });

  // The list starts at the top of the scrolled content, so its box moves
  // up as the container scrolls.
  const getRect = proto.getBoundingClientRect;
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.getAttribute("data-slot") !== "sidebar-menu-sub") {
        return getRect.call(this);
      }
      const top = -(this.closest<HTMLElement>(
        '[data-slot="sidebar-content"]',
      )?.scrollTop ?? 0);
      return new dom.window.DOMRect(0, top, 0, 0);
    },
  });

  // Every listing answers with new objects of the same content.
  const listing = (parentPath: string | null) => {
    const entry = (path: string, extra: Record<string, unknown> = {}) => ({
      name: path.split("/").at(-1),
      path,
      title: path.split("/").at(-1),
      icon: null,
      has_changes: false,
      has_schema: false,
      ...extra,
    });
    if (!parentPath) return [entry("big", { has_children: true })];
    if (parentPath !== "big") return [];
    return Array.from({ length: 5000 }, (_, index) =>
      entry(`big/c${String(index).padStart(4, "0")}.md`),
    );
  };

  let callbackId = 0;
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => ++callbackId,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        switch (command) {
          case "navigation_read":
            return { pinned: [], kept: [] };
          case "get_backlinks":
            return [];
          case "list_tree_children":
            return listing(args.parentPath as string | null);
          case "get_page_detail_state":
            return { form: "leaf", subpageCount: 0, otherFileCount: 0 };
          default:
            return command.includes("expan") ? [] : null;
        }
      },
    },
  });

  // Every render of a row renders its Git indicator once.
  const renders = new Map<string, number>();
  const gitSidebar = await import("@/features/git/sidebar");
  mock.module("@/features/git/sidebar", () => ({
    ...gitSidebar,
    FileGitIndicatorIcon: ({ filePath }: { filePath: string }) => {
      renders.set(filePath, (renders.get(filePath) ?? 0) + 1);
      return null;
    },
  }));

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getNavigationState } = await import("@/features/navigation");
  const { openArtifact, setActiveContentShown, closeActiveContent } =
    await import("@/features/artifact");
  const { useSpaceStore } = await import("../model");
  const { SortableFileTree } = await import("./sortable-file-tree");
  type TreeNode = import("../model/types").TreeNode;

  const root = createRoot(document.getElementById("app")!);
  const settle = (ms = 20) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  const node = (path: string, extra: Partial<TreeNode> = {}): TreeNode => ({
    name: path.split("/").at(-1) ?? path,
    path,
    title: path.split("/").at(-1) ?? path,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
    ...extra,
  });
  const childPath = (index: number) =>
    `big/c${String(index).padStart(4, "0")}.md`;
  const children = Array.from({ length: 5000 }, (_, index) =>
    node(childPath(index)),
  );
  const bigFolder = node("big", { hasChildren: true, children });
  const tree = [bigFolder];

  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: "/project",
    activeSpaceId: "docs",
    spaces: [
      {
        id: "docs",
        name: "Docs",
        icon: "D",
        description: "",
        path: "/project/docs",
        hasSpaces: false,
        hasSchema: false,
        lastOpened: null,
        status: "ready",
        lfsState: "n/a",
      },
    ],
    rootSpaces: [],
    expandedPaths: { docs: ["big"] },
  });
  await act(async () => getNavigationState().setProject("/project"));

  // The store action is one function; a new one would render every row.
  const loadTreeChildren = async () => {};
  async function render(nextTree: TreeNode[]) {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <div data-slot="sidebar-content">
              <SortableFileTree
                spaceId="docs"
                tree={nextTree}
                loadTreeChildren={loadTreeChildren}
                projectPath="/project"
                spacePath="/project/docs"
              />
            </div>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await settle();
  }

  const scroller = () =>
    document.querySelector('[data-slot="sidebar-content"]') as HTMLElement;
  async function scrollTo(top: number) {
    await act(async () => {
      scroller().scrollTop = top;
      scroller().dispatchEvent(new dom.window.Event("scroll"));
    });
    await settle();
  }
  const mountedRows = () => [
    ...document.querySelectorAll<HTMLElement>(".group\\/tree-item"),
  ];
  const row = (title: string) =>
    mountedRows().find((element) => element.textContent?.includes(title)) ??
    null;
  const title = (path: string) => path.split("/").at(-1)!;

  async function openMenu(path: string) {
    const trigger = row(title(path))?.querySelector(
      '[data-slot="dropdown-menu-trigger"]',
    );
    if (!trigger) throw new Error(`no menu trigger for ${path}`);
    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, detail: 0 }),
      );
    });
    await settle();
  }
  async function press(key: string) {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, key }),
      );
    });
    await settle(30);
  }

  test("an expanded folder of 5000 children mounts only the rows in view", async () => {
    await render(tree);
    const rows = mountedRows();
    // 560 px of 32 px rows plus overscan: tens of rows, not thousands.
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.length).toBeLessThan(50);
    expect(
      document.querySelectorAll('[aria-roledescription="sortable"]').length,
    ).toBe(rows.length);
    expect(row("c0000.md")).not.toBeNull();
    expect(row("c4999.md")).toBeNull();

    // The list keeps the height of all rows, so the container scrolls.
    const list = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-menu-sub"]',
    );
    expect(Number.parseFloat(list?.style.height ?? "0")).toBe(
      2 + 28 + 2 + 28 + 4999 * 32 + 2 + 2,
    );

    await scrollTo(32 * 4990);
    expect(row("c4999.md")).not.toBeNull();
    expect(row("c0000.md")).toBeNull();
    expect(mountedRows().length).toBeLessThan(50);
    await scrollTo(0);
  });

  test("a store update a row does not show leaves the row unrendered", async () => {
    await render(tree);
    renders.clear();
    await act(async () => {
      useSpaceStore.setState((state) => ({
        treeLoading: { ...state.treeLoading, docs: true },
        treeRefreshing: { ...state.treeRefreshing, docs: true },
        treeParentLoading: { docs: { "big/other": true } },
        expandedPaths: { ...state.expandedPaths, elsewhere: ["x"] },
      }));
    });
    await settle();
    expect([...renders.keys()]).toEqual([]);

    // A new tree from the store in which one node changed: only its row.
    const changed = { ...children[3], title: "Renamed three" };
    const nextChildren = children.map((child, index) =>
      index === 3 ? changed : child,
    );
    await render([{ ...bigFolder, children: nextChildren }]);
    expect([...renders.keys()]).toEqual([childPath(3)]);
    expect(row("Renamed three")).not.toBeNull();
    await render(tree);
  });

  test("rows with a menu, a delete dialog, a rename or focus stay mounted out of view", async () => {
    await render(tree);

    await openMenu(childPath(3));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await scrollTo(32 * 3000);
    expect(row("c0003.md")).not.toBeNull();
    expect(row("c0004.md")).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // Closing the menu hands focus back to its trigger, which keeps the row.
    await press("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(row("c0003.md")).not.toBeNull();
    await act(async () => (document.activeElement as HTMLElement)?.blur());
    await settle();
    expect(row("c0003.md")).toBeNull();

    await scrollTo(0);
    await openMenu(childPath(5));
    const deleteItem = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.startsWith("Delete"));
    await act(async () => {
      deleteItem?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await scrollTo(32 * 3000);
    expect(row("c0005.md")).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await press("Escape");
    await act(async () => (document.activeElement as HTMLElement)?.blur());
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    await scrollTo(0);
    const button = row("c0001.md")?.querySelector(
      '[data-sidebar="menu-sub-button"]',
    );
    await act(async () => {
      button?.dispatchEvent(
        new dom.window.MouseEvent("dblclick", { bubbles: true }),
      );
    });
    await settle();
    const input = row("")?.ownerDocument.activeElement as HTMLInputElement;
    expect(input instanceof dom.window.HTMLInputElement).toBe(true);
    expect(input.value).toBe("c0001.md");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Draft name");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await scrollTo(32 * 3000);
    const kept = document.querySelector<HTMLInputElement>(
      ".group\\/tree-item input",
    );
    expect(kept).toBe(input);
    expect(kept?.value).toBe("Draft name");
    expect(row("c0002.md")).toBeNull();
    await act(async () => {
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    await settle();
    await scrollTo(0);
  });

  test("a rename asked for outside the tree starts in its row out of view", async () => {
    const { useTreeRenameRequest } =
      await import("../model/tree-rename-request");
    await render(tree);
    expect(row("c4500.md")).toBeNull();
    await act(async () => {
      useTreeRenameRequest.getState().request("docs", childPath(4500));
    });
    await settle(30);
    const input = document.activeElement as HTMLInputElement;
    expect(input instanceof dom.window.HTMLInputElement).toBe(true);
    expect(input.value).toBe("c4500.md");
    expect(useTreeRenameRequest.getState().target).toBeNull();
    await act(async () => {
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    await act(async () => (document.activeElement as HTMLElement)?.blur());
    await settle();
    expect(row("c4500.md")).toBeNull();
  });

  test("content opened outside the tree scrolls its row into the center", async () => {
    await render(tree);
    scrollWrites.length = 0;
    await act(async () => {
      openArtifact({
        spaceId: "docs",
        path: childPath(4000),
        sourceShape: "file",
        semanticHint: { kind: "page" },
      });
      setActiveContentShown(true);
    });
    await settle(100);
    // Row 4000 starts below the folder row and its first child.
    const start = 30 + 30 + 32 * 3999;
    expect(scrollWrites.at(-1)).toBe(start + 32 / 2 - VIEWPORT / 2);
    const active = row("c4000.md")?.querySelector(
      '[data-sidebar="menu-sub-button"]',
    );
    expect(active?.getAttribute("data-active")).toBe("true");
    await act(async () => closeActiveContent());
    await scrollTo(0);
  });

  test("relisting a folder through the store with the same content renders no row", async () => {
    const EMPTY: TreeNode[] = [];
    function StoreTree() {
      const storeTree = useSpaceStore((state) => state.fileTrees.docs ?? EMPTY);
      return (
        <SortableFileTree
          spaceId="docs"
          tree={storeTree}
          loadTreeChildren={loadTreeChildren}
          projectPath="/project"
          spacePath="/project/docs"
        />
      );
    }
    const store = useSpaceStore.getState();
    await act(async () => {
      await store.ensureTreeLoaded("docs");
      if (!useSpaceStore.getState().expandedPaths.docs?.includes("big")) {
        store.toggleExpanded("docs", "big");
      }
      await store.loadTreeChildren("docs", "big");
    });
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <div data-slot="sidebar-content">
              <StoreTree />
            </div>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await settle();
    expect(row("c0000.md")).not.toBeNull();
    expect(mountedRows().length).toBeLessThan(50);

    renders.clear();
    await act(async () => {
      await store.loadTreeChildren("docs", null, { force: true });
      await store.loadTreeChildren("docs", "big", { force: true });
    });
    await settle();
    expect([...renders.keys()]).toEqual([]);

    await act(async () =>
      store.patchPageTreeMeta("docs", childPath(3), "Renamed in store", null),
    );
    await settle();
    expect([...renders.keys()]).toEqual([childPath(3)]);
    expect(row("Renamed in store")).not.toBeNull();
  });
}
