import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, createRef, type ComponentProps } from "react";
import { JSDOM } from "jsdom";

if (process.env.SVODE_SIDEBAR_CONTENT_MENUS_DOM !== "1") {
  test("sidebar content menus DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SIDEBAR_CONTENT_MENUS_DOM: "1" },
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

  const commands: [string, Record<string, unknown>][] = [];
  let folderContents = { subpageCount: 0, otherFileCount: 0 };
  let backlinks: unknown[] = [];
  const pageDto = (path: string) => ({ path, meta: { title: path }, body: "" });
  let callbackId = 0;
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => ++callbackId,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        commands.push([command, args]);
        switch (command) {
          case "navigation_read":
            return { pinned: [], kept: [] };
          case "get_page_detail_state":
            return { form: "folder", ...folderContents };
          case "duplicate_page":
            return pageDto("doc copy.md");
          case "convert_page_to_leaf":
            return pageDto("guide.md");
          case "get_backlinks":
            return backlinks;
          case "list_tree_children":
            return [];
          case "create_page":
            return pageDto("tasks/Untitled.md");
          case "create_folder":
            return "attic/New folder";
          default:
            return command.includes("expan") ? [] : null;
        }
      },
    },
  });

  const opened: string[] = [];
  const pageNavigation = await import("@/features/page/navigation");
  mock.module("@/features/page/navigation", () => ({
    ...pageNavigation,
    useOpenPage: () => (path: string) => opened.push(path),
  }));
  let dirty = false;
  let saves = 0;
  const gitSidebar = await import("@/features/git/sidebar");
  mock.module("@/features/git/sidebar", () => ({
    ...gitSidebar,
    useSpaceSidebarGit: () => ({
      cloning: undefined,
      dirty,
      commitAll: () => (saves += 1),
      recovery: { request: null, recoverFromError: async () => false },
    }),
  }));

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { DndContext } = await import("@dnd-kit/core");
  const { SortableContext } = await import("@dnd-kit/sortable");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getNavigationState } = await import("@/features/navigation");
  const { useSpaceStore } = await import("../model");
  const { SpaceRow } = await import("./space-row");
  const { RootScopeRow } = await import("./root-scope-row");

  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  const space = {
    id: "docs",
    name: "Docs",
    icon: "D",
    description: "",
    path: "/project/docs",
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready" as const,
    lfsState: "n/a" as const,
  };
  const node = (
    path: string,
    title: string,
    extra: Partial<ComponentProps<typeof SpaceRow>["tree"][number]> = {},
  ) => ({
    name: path,
    path,
    title,
    icon: null,
    has_changes: false,
    has_schema: false,
    children: [],
    ...extra,
  });
  const tree = [
    node("doc.md", "Doc"),
    node("guide/README.md", "Guide"),
    node("attic", "Attic"),
    node("tasks/README.md", "Tasks", { has_schema: true }),
    node("board/README.md", "Board", { has_app: true }),
    node("tool", "Tool", { has_app: true }),
  ];

  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: "/project",
    activeSpaceId: "docs",
    spaces: [space],
    rootSpaces: [],
  });
  await act(async () => getNavigationState().setProject("/project"));

  const calls: string[] = [];
  const spaceProps = (
    overrides: Partial<ComponentProps<typeof SpaceRow>> = {},
  ): ComponentProps<typeof SpaceRow> => ({
    ws: space,
    isActive: false,
    tree,
    editingSpaceId: null,
    editValue: "",
    activeRevealKey: null,
    setEditValue: () => {},
    setEditingSpaceId: (id) => calls.push(`edit-space:${id}`),
    handleRenameSpace: () => {},
    handleNewPage: () => calls.push("space-new-page"),
    handleNewFolder: () => calls.push("space-new-folder"),
    handleNewCollection: () => calls.push("space-new-collection"),
    openScopeHome: () => {},
    setDeleteTarget: (target) => calls.push(`remove-space:${target.id}`),
    handleCloneMissing: () => {},
    handleRemoveBroken: () => {},
    ensureTreeLoaded: async () => {},
    scopeState: { manuallyCollapsedRevealKey: null, manuallyOpened: true },
    loadTreeChildren: async () => {},
    onScopeStateChange: () => {},
    onActivateContent: () => {},
    onBeforeNavigation: async () => true,
    editRef: createRef<HTMLInputElement>(),
    rootPath: "/project",
    loading: false,
    refreshing: false,
    treeLoaded: true,
    ...overrides,
  });

  async function render(element: React.ReactNode) {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <DndContext>
              <SortableContext items={[space.id]}>{element}</SortableContext>
            </DndContext>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await settle();
  }

  async function closeMenu() {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    await settle();
  }

  async function openMenu(trigger: Element) {
    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, detail: 0 }),
      );
    });
    await settle();
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error("menu did not open");
    return [...menu.querySelectorAll("[data-content-action-group]")].map(
      (group) => ({
        group: group.getAttribute("data-content-action-group"),
        items: [...group.querySelectorAll('[role="menuitem"]')].map(
          (item) => item.textContent,
        ),
      }),
    );
  }

  function treeTrigger(title: string) {
    const row = [...document.querySelectorAll(".group\\/tree-item")].find(
      (element) => element.textContent?.includes(title),
    );
    const trigger = row?.querySelector('[data-slot="dropdown-menu-trigger"]');
    if (!trigger) throw new Error(`no menu trigger for ${title}`);
    return trigger;
  }

  function spaceTrigger() {
    const trigger = document.querySelector(
      '[data-sidebar="menu-item"] > [data-slot="dropdown-menu-trigger"]',
    );
    if (!trigger) throw new Error("no Space menu trigger");
    return trigger;
  }

  async function select(label: string) {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent?.startsWith(label),
    ) as HTMLElement | undefined;
    if (!item) throw new Error(`no menu item ${label}`);
    // The operation's own async steps settle inside the same act scope.
    await act(async () => {
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  const pin = ["Pin", "Keep in Now"];

  test("every tree node type shows the catalog menu of its type", async () => {
    await render(<SpaceRow {...spaceProps()} />);

    expect(await openMenu(treeTrigger("Doc"))).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["Nest page", "New folder"] },
      { group: "convert", items: ["Make collection"] },
      { group: "edit", items: ["Rename", "Duplicate"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    folderContents = { subpageCount: 2, otherFileCount: 0 };
    const guide = await openMenu(treeTrigger("Guide"));
    expect(guide).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["Nest page", "New folder"] },
      {
        group: "convert",
        items: [
          "Make collection",
          "Make regular pageFolder contains 2 subpages, 0 other file(s) — move them out first",
        ],
      },
      { group: "edit", items: ["Rename", "Duplicate"] },
      { group: "delete", items: ["Delete"] },
    ]);
    const makeLeaf = document.querySelector(
      '[data-content-action="make-leaf"]',
    );
    expect(makeLeaf?.getAttribute("aria-disabled")).toBe("true");
    await closeMenu();

    expect(await openMenu(treeTrigger("Attic"))).toEqual([
      { group: "create", items: ["Nest page", "New folder"] },
      { group: "convert", items: ["Make Page", "Make collection"] },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    expect(await openMenu(treeTrigger("Tasks"))).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["New item"] },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    for (const app of ["Board", "Tool"]) {
      expect(await openMenu(treeTrigger(app))).toEqual([
        { group: "navigation", items: pin },
        { group: "edit", items: ["Rename"] },
        { group: "delete", items: ["Delete"] },
      ]);
      await closeMenu();
    }
  });

  test("tree node actions run their existing operations", async () => {
    await render(<SpaceRow {...spaceProps()} />);
    commands.length = 0;
    opened.length = 0;
    await openMenu(treeTrigger("Doc"));
    await select("Duplicate");
    expect(commands.find(([command]) => command === "duplicate_page")).toEqual([
      "duplicate_page",
      { space: "/project/docs", filePath: "doc.md", projectPath: "/project" },
    ]);
    expect(opened).toEqual(["doc copy.md"]);

    folderContents = { subpageCount: 0, otherFileCount: 0 };
    await openMenu(treeTrigger("Guide"));
    await select("Make regular page");
    expect(
      commands.find(([command]) => command === "convert_page_to_leaf"),
    ).toEqual([
      "convert_page_to_leaf",
      {
        space: "/project/docs",
        filePath: "guide/README.md",
        projectPath: "/project",
      },
    ]);
    expect(opened.at(-1)).toBe("guide.md");

    await openMenu(treeTrigger("Tasks"));
    await select("New item");
    const created = commands.find(([command]) => command === "create_page");
    expect([created?.[1].space, created?.[1].parentPath]).toEqual([
      "/project/docs",
      "tasks",
    ]);

    await openMenu(treeTrigger("Attic"));
    await select("New folder");
    const folder = commands.find(([command]) => command === "create_folder");
    expect([folder?.[1].space, folder?.[1].parentPath]).toEqual([
      "/project/docs",
      "attic",
    ]);

    await openMenu(treeTrigger("Doc"));
    await select("Delete");
    expect(commands.some(([command]) => command === "get_backlinks")).toBe(
      true,
    );
    expect(document.querySelector('[role="alertdialog"]') === null).toBe(false);
    await closeMenu();

    // Focus after Rename from the menu belongs to DF-157, so the field may
    // already have closed again; it must have opened with the current name.
    const renameValues: string[] = [];
    const observer = new dom.window.MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          const input =
            added instanceof dom.window.HTMLInputElement
              ? added
              : added instanceof dom.window.Element
                ? added.querySelector("input")
                : null;
          if (input) renameValues.push(input.value);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await openMenu(treeTrigger("Board"));
    await select("Rename");
    observer.disconnect();
    expect(renameValues[0]).toBe("Board");
  });

  test("a rename asked for outside the tree starts in the row of its path", async () => {
    const { useTreeRenameRequest } =
      await import("../model/tree-rename-request");
    await render(<SpaceRow {...spaceProps()} />);
    await act(async () => {
      useTreeRenameRequest.getState().request("docs", "tool");
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const input = document.activeElement;
    expect(input instanceof dom.window.HTMLInputElement).toBe(true);
    expect((input as HTMLInputElement).value).toBe("Tool");
    expect(useTreeRenameRequest.getState().target).toBeNull();
    await act(async () => {
      input?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    await settle();
  });

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

  test("deleting a tree node confirms with its type, name, consequences and links", async () => {
    await render(<SpaceRow {...spaceProps()} />);
    const deletes = () =>
      commands.filter(([command]) => command === "delete_content");

    backlinks = [
      { sourceSpaceId: null, sourcePath: "notes/plan.md", linkCount: 1 },
      { sourceSpaceId: "docs", sourcePath: "intro.md", linkCount: 2 },
    ];
    await openMenu(treeTrigger("Doc"));
    await select("Delete");
    await settle();
    expect(deleteDialog()).toEqual({
      title: "Delete page?",
      description: "The page “Doc” will be deleted.",
      backlinks: ["notes/plan.md", "Docs · intro.md"],
    });
    expect(
      commands.filter(([command]) => command === "get_backlinks").at(-1)?.[1],
    ).toEqual({
      space: "/project/docs",
      targetPath: "doc.md",
      projectPath: "/project",
    });
    commands.length = 0;
    await clickDialogButton("Cancel");
    expect(deleteDialog()).toBeNull();
    expect(deletes()).toEqual([]);

    backlinks = [];
    const cases: [string, string, string][] = [
      [
        "Guide",
        "Delete page?",
        "The page “Guide” will be deleted with its nested pages and files.",
      ],
      [
        "Attic",
        "Delete folder?",
        "The folder “Attic” and everything inside it will be deleted.",
      ],
      [
        "Tasks",
        "Delete collection?",
        "The collection “Tasks” will be deleted with its schema and all items.",
      ],
      [
        "Board",
        "Delete app?",
        "The app “Board” will be deleted with its files.",
      ],
      ["Tool", "Delete app?", "The app “Tool” will be deleted with its files."],
    ];
    folderContents = { subpageCount: 1, otherFileCount: 0 };
    for (const [title, dialogTitle, description] of cases) {
      await openMenu(treeTrigger(title));
      await select("Delete");
      await settle();
      expect(deleteDialog()).toEqual({
        title: dialogTitle,
        description,
        backlinks: [],
      });
      await clickDialogButton("Cancel");
    }
    expect(deletes()).toEqual([]);

    await openMenu(treeTrigger("Attic"));
    await select("Delete");
    await settle();
    await clickDialogButton("Delete");
    expect(deleteDialog()).toBeNull();
    expect(deletes()).toEqual([
      [
        "delete_content",
        { space: "/project/docs", path: "attic", projectPath: "/project" },
      ],
    ]);
    folderContents = { subpageCount: 0, otherFileCount: 0 };
  });

  test("the Space row menu adds Save all with unsaved changes and its launch group", async () => {
    dirty = false;
    await render(<SpaceRow {...spaceProps()} tree={[]} />);
    expect(await openMenu(spaceTrigger())).toEqual([
      { group: "navigation", items: pin },
      {
        group: "create",
        items: ["New page", "New folder", "New collection"],
      },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Remove"] },
    ]);
    await closeMenu();

    dirty = true;
    const launched: string[] = [];
    await render(
      <SpaceRow
        {...spaceProps({
          tree: [],
          onNewSession: (path) => launched.push(`session:${path}`),
          onNewTerminal: (path) => launched.push(`terminal:${path}`),
        })}
      />,
    );
    expect(await openMenu(spaceTrigger())).toEqual([
      { group: "navigation", items: pin },
      {
        group: "create",
        items: ["New page", "New folder", "New collection"],
      },
      { group: "launch", items: ["New session", "New terminal"] },
      { group: "edit", items: ["Save all", "Rename"] },
      { group: "delete", items: ["Remove"] },
    ]);

    calls.length = 0;
    for (const label of [
      "New page",
      "New folder",
      "New collection",
      "New session",
      "New terminal",
      "Save all",
      "Rename",
      "Remove",
    ]) {
      if (!document.querySelector('[role="menu"]')) {
        await openMenu(spaceTrigger());
      }
      await select(label);
    }
    expect(calls).toEqual([
      "space-new-page",
      "space-new-folder",
      "space-new-collection",
      "edit-space:docs",
      "remove-space:docs",
    ]);
    expect(launched).toEqual([
      "session:/project/docs",
      "terminal:/project/docs",
    ]);
    expect(saves).toBe(1);
  });

  test("the project root menu pins and creates, with its launch group when given", async () => {
    const created: string[] = [];
    const rootRow = (launch: boolean) => (
      <RootScopeRow
        active={false}
        icon={null}
        name="Project"
        open={false}
        tree={[]}
        onOpenChange={() => {}}
        onOpenHome={() => {}}
        onNewPage={() => created.push("page")}
        onNewFolder={() => created.push("folder")}
        onNewCollection={() => created.push("collection")}
        {...(launch
          ? {
              onNewSession: () => created.push("session"),
              onNewTerminal: () => created.push("terminal"),
            }
          : {})}
        spaceId="root"
        rootPath="/project"
        loading={false}
        refreshing={false}
        treeLoaded
        loadTreeChildren={async () => {}}
        onActivateContent={() => {}}
        onBeforeNavigation={async () => true}
      />
    );
    await render(rootRow(false));
    expect(await openMenu(spaceTrigger())).toEqual([
      { group: "navigation", items: pin },
      {
        group: "create",
        items: ["New page", "New folder", "New collection"],
      },
    ]);
    await closeMenu();

    await render(rootRow(true));
    expect(await openMenu(spaceTrigger())).toEqual([
      { group: "navigation", items: pin },
      {
        group: "create",
        items: ["New page", "New folder", "New collection"],
      },
      { group: "launch", items: ["New session", "New terminal"] },
    ]);
    for (const label of [
      "New page",
      "New folder",
      "New collection",
      "New session",
      "New terminal",
    ]) {
      if (!document.querySelector('[role="menu"]')) {
        await openMenu(spaceTrigger());
      }
      await select(label);
    }
    expect(created).toEqual([
      "page",
      "folder",
      "collection",
      "session",
      "terminal",
    ]);
    await act(async () => root.unmount());
  });
}
