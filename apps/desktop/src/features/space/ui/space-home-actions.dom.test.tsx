import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { JSDOM } from "jsdom";

if (process.env.SVODE_SPACE_HOME_ACTIONS_DOM !== "1") {
  test("Space home header menu DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SPACE_HOME_ACTIONS_DOM: "1" },
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
  const { SidebarProvider, useSidebar } =
    await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getNavigationState, spaceNavigationKey } =
    await import("@/features/navigation");
  const { useSpaceStore } = await import("../model");
  const { NavSpaces } = await import("./nav-spaces");
  const { ProjectRootHomeActions, SpaceHomeActions } =
    await import("./space-home-actions");
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
  useSpaceStore.setState({
    activeRootId: "root",
    activeRootPath: "/project",
    activeRootName: "Project",
    activeSpaceId: "docs",
    spaces: [space],
    rootSpaces: [],
    fileTrees: { root: [], docs: [] },
  });
  await act(async () => getNavigationState().setProject("/project"));

  const sidebar = { open: true };
  function SidebarState() {
    const { open } = useSidebar();
    useEffect(() => {
      sidebar.open = open;
    }, [open]);
    return null;
  }

  async function render(
    scope: "space" | "root",
    options: {
      readOnly?: boolean;
      withSidebar?: boolean;
      sidebarOpen?: boolean;
    } = {},
  ) {
    const props = {
      spaceId: scope === "space" ? "docs" : "root",
      spacePath: scope === "space" ? "/project/docs" : "/project",
      projectPath: "/project",
      pinItem: {
        key: spaceNavigationKey(scope === "space" ? "docs" : "root", "root"),
        title: "Docs",
      },
      readOnly: options.readOnly,
      onBeforeNavigation: async () => true,
    };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider
            key={`sidebar:${options.sidebarOpen ?? true}`}
            defaultOpen={options.sidebarOpen ?? true}
          >
            <SidebarState />
            <div data-header>
              {scope === "space" ? (
                <SpaceHomeActions
                  key={`space:${options.readOnly}`}
                  {...props}
                />
              ) : (
                <ProjectRootHomeActions {...props} />
              )}
            </div>
            {options.withSidebar ? (
              <NavSpaces
                onActivateContent={() => {}}
                onBeforeNavigation={async () => true}
              />
            ) : null}
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

  test("the Space and root headers show the menu of their sidebar rows", async () => {
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

    await render("space", { readOnly: true });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: pin },
      {
        group: "create",
        items: [
          "New page (disabled)",
          "New folder (disabled)",
          "New collection (disabled)",
        ],
      },
      { group: "edit", items: ["Rename (disabled)"] },
      { group: "delete", items: ["Remove (disabled)"] },
    ]);
    await closeMenu();
  });

  test("Space items run the operations of its sidebar row", async () => {
    await render("space");
    commands.length = 0;
    opened.length = 0;
    await openMenu();
    await select("New page");
    expect(commands.some(([command]) => command === "create_page")).toBe(true);
    await openMenu();
    await select("New folder");
    expect(
      commands.find(([command]) => command === "create_folder")?.[1],
    ).toEqual({
      space: "/project/docs",
      parentPath: null,
      name: "New folder",
      projectPath: "/project",
    });

    dirty = true;
    saves = 0;
    await render("space");
    await openMenu();
    await select("Save all");
    expect(saves).toBe(1);
    dirty = false;

    // Remove opens the Space removal dialog, not a README deletion.
    commands.length = 0;
    await render("space");
    await openMenu();
    await select("Remove");
    expect(dialog()).toEqual({
      title: "Remove space?",
      description:
        "The space will be removed from the project. Files will remain on disk.",
    });
    await clickDialogButton("Cancel");
    expect(dialog()).toBeNull();
    await openMenu();
    await select("Remove");
    await clickDialogButton("Remove");
    expect(commands.filter(([command]) => command === "delete_space")).toEqual([
      [
        "delete_space",
        { parentPath: "/project", spaceId: "docs", deleteFiles: false },
      ],
    ]);
    expect(commands.some(([command]) => command === "delete_content")).toBe(
      false,
    );
  });

  test("Space Rename edits its sidebar row, shown first", async () => {
    useSpaceStore.setState({ spaces: [space] });
    await render("space", { withSidebar: true, sidebarOpen: false });
    expect(sidebar.open).toBe(false);
    await openMenu();
    await select("Rename");
    await settle();
    expect(sidebar.open).toBe(true);
    const input = document.querySelector<HTMLInputElement>(
      '[data-sidebar="menu-button"] input',
    )!;
    expect(input.value).toBe("Docs");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);

    // Escape cancels.
    await act(async () => {
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    await settle();
    expect(
      document.querySelector('[data-sidebar="menu-button"] input'),
    ).toBeNull();
    expect(commands.some(([command]) => command === "save_space_config")).toBe(
      false,
    );

    // Enter applies the new name.
    await openMenu();
    await select("Rename");
    await settle();
    const next = document.querySelector<HTMLInputElement>(
      '[data-sidebar="menu-button"] input',
    )!;
    expect(document.activeElement).toBe(next);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(next, "Handbook");
      next.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      next.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await settle();
    expect(
      commands.find(([command]) => command === "save_space_config")?.[1],
    ).toEqual({
      spacePath: "/project/docs",
      configData: { name: "Handbook" },
      projectPath: "/project",
    });
    await act(async () => root.unmount());
  });
}
