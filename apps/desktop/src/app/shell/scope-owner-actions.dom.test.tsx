import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Page } from "@/features/page";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

if (process.env.SVODE_SCOPE_OWNER_ACTIONS_DOM !== "1") {
  test("scope owner header menus DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SCOPE_OWNER_ACTIONS_DOM: "1" },
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
  let callbackId = 0;
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => ++callbackId,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        commands.push([command, args]);
        switch (command) {
          case "navigation_read":
            return { pinned: [], kept: [] };
          case "get_backlinks":
          case "list_tree_children":
          case "list_content_tree":
            return [];
          case "create_page":
            return {
              path: `${String(args.parentPath)}/Untitled.md`,
              body: "",
              meta: { title: "Untitled" },
            };
          case "get_space_config":
            return { name: "Docs" };
          default:
            return command.includes("expan") ? [] : null;
        }
      },
    },
  });

  Object.defineProperty(dom.window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: { unregisterListener() {} },
  });

  const page = (path: string, title: string): Page => ({
    path,
    body: "",
    meta: { title, icon: null, created: "", updated: "", extra: {} },
  });
  let context = {
    page: page("tasks/README.md", "Tasks") as Page | null,
    schemaResult: null as object | null,
    status: "ready" as "ready" | "missing",
    fallbackTitle: "X",
  };
  let titleFocusRequests = 0;
  const scopeSurface = await import("@/features/page/scope-surface");
  mock.module("@/features/page/scope-surface", () => ({
    ...scopeSurface,
    usePageDetailContext: () => ({
      ...context,
      spacePath: "/project/docs",
      projectPath: "/project",
      spaceId: "docs",
      setPage: () => {},
      reload: async () => {},
      requestTitleFocus: () => (titleFocusRequests += 1),
    }),
    usePageSurfaceSession: () => ({
      prepareForNavigation: async () => true,
    }),
  }));
  const pageActions: { props: Record<string, unknown> | null } = {
    props: null,
  };
  const renderedPageActions = () => pageActions.props;
  const pageDetail = await import("@/features/page/detail");
  mock.module("@/features/page/detail", () => ({
    ...pageDetail,
    PageDetailActions: (props: Record<string, unknown>) => {
      pageActions.props = props;
      return null;
    },
  }));
  const opened: string[] = [];
  const pageNavigation = await import("@/features/page/navigation");
  mock.module("@/features/page/navigation", () => ({
    ...pageNavigation,
    useOpenPage: () => (path: string) => opened.push(path),
  }));
  const rowRenames: string[] = [];
  const spaceAppShell = await import("@/features/space/app-shell");
  mock.module("@/features/space/app-shell", () => ({
    ...spaceAppShell,
    useRequestTreeRowRename: () => (spaceId: string, path: string) =>
      rowRenames.push(`${spaceId}:${path}`),
  }));
  let dirty = false;
  const gitSidebar = await import("@/features/git/sidebar");
  mock.module("@/features/git/sidebar", () => ({
    ...gitSidebar,
    useSpaceSidebarGit: () => ({
      cloning: undefined,
      dirty,
      commitAll: () => {},
      recovery: { request: null, recoverFromError: async () => false },
    }),
  }));

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getNavigationState, artifactNavigationKey, spaceNavigationKey } =
    await import("@/features/navigation");
  const { ScopeOwnerActions } = await import("./scope-owner-actions");
  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  await act(async () => getNavigationState().setProject("/project"));

  const owners: Record<string, ScopeOwnerRef> = {
    collection: {
      ownerKey: "collection:docs:tasks",
      identityKind: "collection-directory",
      spaceId: "docs",
      spacePath: "/project/docs",
      projectPath: "/project",
      ownerPath: "tasks",
      readmePath: "tasks/README.md",
      capabilities: ["collection"],
    },
    app: {
      ownerKey: "app:docs:board",
      identityKind: "app-directory",
      spaceId: "docs",
      spacePath: "/project/docs",
      projectPath: "/project",
      ownerPath: "board",
      readmePath: "board/README.md",
      capabilities: ["app"],
    },
    space: {
      ownerKey: "space:docs",
      identityKind: "registered-space",
      spaceId: "docs",
      spacePath: "/project/docs",
      projectPath: "/project",
      ownerPath: ".",
      readmePath: "README.md",
      capabilities: ["space"],
    },
    root: {
      ownerKey: "space:root",
      identityKind: "registered-space",
      spaceId: "root",
      spacePath: "/project",
      projectPath: "/project",
      ownerPath: ".",
      readmePath: "README.md",
      capabilities: ["space"],
    },
    pageApp: {
      ownerKey: "page:docs:dash",
      identityKind: "page-directory",
      spaceId: "docs",
      spacePath: "/project/docs",
      projectPath: "/project",
      ownerPath: "dash",
      readmePath: "dash/README.md",
      capabilities: ["app"],
    },
    page: {
      ownerKey: "page:docs:guide",
      identityKind: "page-directory",
      spaceId: "docs",
      spacePath: "/project/docs",
      projectPath: "/project",
      ownerPath: "guide",
      readmePath: "guide/README.md",
      capabilities: [],
    },
  };

  async function render(
    ownerName: keyof typeof owners,
    options: { readOnly?: boolean; withoutReadme?: boolean } = {},
  ) {
    const owner = owners[ownerName];
    context = {
      page: options.withoutReadme
        ? null
        : page(owner.readmePath, ownerName === "space" ? "Docs home" : "X"),
      schemaResult: null,
      status: options.withoutReadme ? "missing" : "ready",
      fallbackTitle: "X",
    };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <div data-header>
              <ScopeOwnerActions
                key={`${ownerName}:${options.readOnly}:${options.withoutReadme}`}
                owner={owner}
                pinItem={{
                  key:
                    owner.identityKind === "registered-space"
                      ? spaceNavigationKey(owner.spaceId, "root")
                      : artifactNavigationKey(
                          "collection",
                          owner.ownerPath,
                          "docs",
                          null,
                        ),
                  title: "Owner",
                }}
                readOnly={options.readOnly}
              />
            </div>
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await settle();
  }

  async function openMenu() {
    const trigger = document.querySelector(
      '[data-header] [data-slot="dropdown-menu-trigger"]',
    );
    if (!trigger) throw new Error("no header menu trigger");
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
        items: [...group.querySelectorAll('[role="menuitem"]')].map((item) =>
          item.getAttribute("aria-disabled") === "true"
            ? `${item.textContent} (disabled)`
            : item.textContent,
        ),
      }),
    );
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

  async function select(label: string) {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent?.startsWith(label),
    ) as HTMLElement | undefined;
    if (!item) throw new Error(`no menu item ${label}`);
    await act(async () => {
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await settle();
  }

  function dialog() {
    const element = document.querySelector('[role="alertdialog"]');
    if (!element) return null;
    return {
      title: element.querySelector('[data-slot="alert-dialog-title"]')
        ?.textContent,
      description: element.querySelector(
        '[data-slot="alert-dialog-description"]',
      )?.textContent,
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

  const pin = ["Pin", "Keep in Now"];

  test("owner headers show the menu of the owner, not of its README", async () => {
    await render("collection");
    expect(await openMenu()).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["New item"] },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    for (const app of ["app", "pageApp"] as const) {
      await render(app);
      expect(await openMenu()).toEqual([
        { group: "navigation", items: pin },
        { group: "edit", items: ["Rename"] },
        { group: "delete", items: ["Delete"] },
      ]);
      await closeMenu();
    }

    for (const unsaved of [false, true]) {
      dirty = unsaved;
      await render("space");
      expect(await openMenu()).toEqual([
        { group: "navigation", items: pin },
        {
          group: "create",
          items: ["New page", "New folder", "New collection"],
        },
        {
          group: "edit",
          items: unsaved ? ["Save all", "Rename"] : ["Rename"],
        },
        { group: "delete", items: ["Remove"] },
      ]);
      await closeMenu();
    }
    dirty = false;

    await render("root");
    expect(await openMenu()).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["New page", "New folder", "New collection"] },
    ]);
    await closeMenu();

    pageActions.props = null;
    await render("page");
    const props = renderedPageActions();
    expect(props?.menuKind).toEqual({ kind: "page" });
    expect(Boolean(props?.pinItem)).toBe(true);
  });

  test("read-only owner headers keep their items and leave pinning", async () => {
    await render("collection", { readOnly: true });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["New item (disabled)"] },
      { group: "edit", items: ["Rename (disabled)"] },
      { group: "delete", items: ["Delete (disabled)"] },
    ]);
    await closeMenu();
  });

  test("an App or a Collection without README keeps its menu on its folder", async () => {
    await render("app", { withoutReadme: true });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: pin },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Delete"] },
    ]);
    titleFocusRequests = 0;
    await select("Rename");
    expect(titleFocusRequests).toBe(0);
    expect(rowRenames).toEqual(["docs:board"]);

    commands.length = 0;
    await openMenu();
    await select("Delete");
    expect(dialog()).toEqual({
      title: "Delete app?",
      description: "The app “X” will be deleted with its files.",
    });
    await clickDialogButton("Delete");
    expect(
      commands.filter(([command]) => command === "delete_content"),
    ).toEqual([
      [
        "delete_content",
        { space: "/project/docs", path: "board", projectPath: "/project" },
      ],
    ]);

    await render("collection", { withoutReadme: true });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: pin },
      { group: "create", items: ["New item"] },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    await render("page", { withoutReadme: true });
    expect(
      document.querySelector(
        '[data-header] [data-slot="dropdown-menu-trigger"]',
      ),
    ).toBeNull();
  });

  test("Collection and App items run their operations", async () => {
    await render("collection");
    commands.length = 0;
    opened.length = 0;
    await openMenu();
    await select("New item");
    const created = commands.find(([command]) => command === "create_page");
    expect([created?.[1].space, created?.[1].parentPath]).toEqual([
      "/project/docs",
      "tasks",
    ]);
    expect(opened).toEqual(["tasks/Untitled.md"]);

    titleFocusRequests = 0;
    await openMenu();
    await select("Rename");
    expect(titleFocusRequests).toBe(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    const cases: [keyof typeof owners, string, string][] = [
      [
        "collection",
        "Delete collection?",
        "The collection “X” will be deleted with its schema and all items.",
      ],
      ["app", "Delete app?", "The app “X” will be deleted with its files."],
      ["pageApp", "Delete app?", "The app “X” will be deleted with its files."],
    ];
    for (const [owner, title, description] of cases) {
      await render(owner);
      await openMenu();
      await select("Delete");
      expect(dialog()).toEqual({ title, description });
      await clickDialogButton("Cancel");
      expect(dialog()).toBeNull();
    }

    commands.length = 0;
    await render("collection");
    await openMenu();
    await select("Delete");
    await clickDialogButton("Delete");
    expect(
      commands.filter(([command]) => command === "delete_content"),
    ).toEqual([
      [
        "delete_content",
        {
          space: "/project/docs",
          path: "tasks/README.md",
          projectPath: "/project",
        },
      ],
    ]);
    await act(async () => root.unmount());
  });
}
