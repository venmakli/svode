import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ComponentProps } from "react";
import { JSDOM } from "jsdom";

if (process.env.SVODE_PAGE_DETAIL_ACTIONS_DOM !== "1") {
  test("Page header menu DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_DETAIL_ACTIONS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
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
  let detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
  const pageDto = (path: string, title = "Roadmap") => ({
    path,
    body: "",
    sourceVersion: "v1",
    meta: { title, icon: null, created: "", updated: "", extra: {} },
  });
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc(
    async (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      commands.push([command, args]);
      switch (command) {
        case "navigation_read":
          return { pinned: [], kept: [] };
        case "repository_access_get":
          return {
            checkedAt: null,
            expiresAt: null,
            generation: 1,
            lastKnownStatus: null,
            reason: null,
            repositoryId: "/project/docs",
            status: "local",
          };
        case "read_page":
          return pageDto(String(args.path));
        case "get_page_detail_state":
          return detailState;
        case "update_page_field":
          return pageDto(String(args.filePath), String(args.value));
        case "convert_page_to_folder":
          return pageDto("roadmap/README.md");
        case "convert_page_to_leaf":
          return pageDto("roadmap.md");
        case "convert_to_collection":
          return { entry: pageDto("roadmap/README.md") };
        case "create_page":
          return pageDto(`${String(args.parentPath)}/Untitled.md`, "Untitled");
        case "create_folder":
          return `${String(args.parentPath)}/New folder`;
        default:
          return command.includes("expan") ? [] : null;
      }
    },
    { shouldMockEvents: true },
  );

  // React DOM reads the environment when it loads, so after the globals.
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { PageSurfaceSessionProvider } =
    await import("../hooks/page-surface-context");
  const { getNavigationState, artifactNavigationKey } =
    await import("@/features/navigation");
  const { PageDetailProvider, usePageDetailContext } =
    await import("../hooks/page-detail-context");
  const { PageDetailHeader } = await import("./page-detail-header");
  const { PageDetailActions } = await import("./page-detail-actions");

  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  await act(async () => getNavigationState().setProject("/project"));

  const calls: string[] = [];
  type ActionsProps = ComponentProps<typeof PageDetailActions>;

  function Header({
    readOnly,
    ...props
  }: Pick<ActionsProps, "menuKind" | "pinItem" | "readOnly">) {
    const context = usePageDetailContext();
    return (
      <PageDetailHeader
        readOnly={readOnly}
        actions={
          context.page ? (
            <PageDetailActions
              {...props}
              page={context.page}
              spacePath="/project/docs"
              projectPath="/project"
              spaceId="docs"
              readOnly={readOnly}
              onConverted={(page, nested) =>
                calls.push(`converted:${page.path}:${nested}`)
              }
              onDuplicatePage={(page) => {
                calls.push(`duplicate:${page.path}`);
              }}
              onDeletePage={(page) => calls.push(`delete:${page.path}`)}
              onSetTemplateDefault={async (isDefault) => {
                calls.push(`default:${isDefault}`);
              }}
            />
          ) : null
        }
      />
    );
  }

  async function render(
    path: string,
    props: Pick<ActionsProps, "menuKind" | "pinItem" | "readOnly">,
  ) {
    await act(async () =>
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <PageSurfaceSessionProvider
              key={`${path}:${JSON.stringify(props)}`}
              displayName={path}
              displayPath={path}
              spacePath="/project/docs"
              targetKey={path}
            >
              <PageDetailProvider
                spacePath="/project/docs"
                projectPath="/project"
                spaceId="docs"
                readmePath={path}
                ownerPath={path.replace(/\/readme\.md$/i, "")}
                target="page"
                onOpenPath={() => {}}
              >
                <Header {...props} />
              </PageDetailProvider>
            </PageSurfaceSessionProvider>
          </TooltipProvider>
        </ThemeProvider>,
      ),
    );
    await settle();
    await settle();
  }

  async function openMenu() {
    // The header also holds the cover picker; the actions menu comes last.
    const trigger = [
      ...document.querySelectorAll(
        '[data-page-detail-header] [data-slot="dropdown-menu-trigger"]',
      ),
    ].at(-1);
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
  }

  const pinItem = {
    key: artifactNavigationKey("page", "roadmap.md", "docs", null),
    title: "Roadmap",
  };
  const blocked =
    "Folder contains 2 subpages, 0 other file(s) — move them out first";

  test("the header menu of each Page form is its catalog menu", async () => {
    detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
    await render("roadmap.md", { menuKind: { kind: "page" }, pinItem });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: ["Pin", "Keep in Now"] },
      { group: "create", items: ["Nest page", "New folder"] },
      { group: "convert", items: ["Make collection"] },
      { group: "edit", items: ["Rename", "Duplicate"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    detailState = { form: "folder", subpageCount: 2, otherFileCount: 0 };
    await render("tasks/plan/README.md", {
      menuKind: { kind: "collection-item" },
      pinItem,
    });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: ["Pin", "Keep in Now"] },
      { group: "create", items: ["Nest page", "New folder"] },
      {
        group: "convert",
        items: ["Make collection", `Make regular page${blocked} (disabled)`],
      },
      { group: "edit", items: ["Rename", "Duplicate"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    // A folder Page with an App is an App, as in the sidebar.
    detailState = { form: "folder", subpageCount: 0, otherFileCount: 1 };
    await render("dash/README.md", { menuKind: { kind: "app" }, pinItem });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: ["Pin", "Keep in Now"] },
      { group: "edit", items: ["Rename"] },
      { group: "delete", items: ["Delete"] },
    ]);
    await closeMenu();

    detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
    for (const [isDefault, label] of [
      [false, "Set as default"],
      [true, "Unset default"],
    ] as const) {
      await render(".templates/bug.md", {
        menuKind: { kind: "template", isDefault },
        pinItem: null,
      });
      expect(await openMenu()).toEqual([
        { group: "navigation", items: [label] },
        { group: "create", items: ["Nest page", "New folder"] },
        { group: "convert", items: ["Make collection"] },
        { group: "edit", items: ["Rename", "Duplicate template"] },
        { group: "delete", items: ["Delete"] },
      ]);
      await closeMenu();
    }
  });

  test("read-only keeps the menu and leaves only pinning available", async () => {
    detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
    await render("roadmap.md", {
      menuKind: { kind: "page" },
      pinItem,
      readOnly: true,
    });
    expect(await openMenu()).toEqual([
      { group: "navigation", items: ["Pin", "Keep in Now"] },
      {
        group: "create",
        items: ["Nest page (disabled)", "New folder (disabled)"],
      },
      { group: "convert", items: ["Make collection (disabled)"] },
      {
        group: "edit",
        items: ["Rename (disabled)", "Duplicate (disabled)"],
      },
      { group: "delete", items: ["Delete (disabled)"] },
    ]);
    await closeMenu();

    await render(".templates/bug.md", {
      menuKind: { kind: "template", isDefault: false },
      pinItem: null,
      readOnly: true,
    });
    expect((await openMenu())[0]).toEqual({
      group: "navigation",
      items: ["Set as default (disabled)"],
    });
    await closeMenu();
  });

  test("header items run the existing operations of the Page", async () => {
    const run = async (label: string) => {
      await openMenu();
      commands.length = 0;
      calls.length = 0;
      await select(label);
      await settle();
      return commands.map(([command]) => command);
    };

    detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
    await render("roadmap.md", { menuKind: { kind: "page" }, pinItem });
    const nested = await run("Nest page");
    expect(nested.includes("convert_page_to_folder")).toBe(true);
    expect(
      commands.find(([command]) => command === "create_page")?.[1].parentPath,
    ).toBe("roadmap");
    expect(calls).toEqual(["converted:roadmap/Untitled.md:false"]);

    await render("roadmap.md", { menuKind: { kind: "page" }, pinItem });
    await run("New folder");
    expect(
      commands.find(([command]) => command === "create_folder")?.[1],
    ).toEqual({
      space: "/project/docs",
      parentPath: "roadmap",
      name: "New folder",
      projectPath: "/project",
    });
    expect(calls).toEqual(["converted:roadmap/README.md:false"]);

    await render("roadmap.md", { menuKind: { kind: "page" }, pinItem });
    await run("Make collection");
    expect(
      commands.find(([command]) => command === "convert_to_collection")?.[1],
    ).toEqual({
      space: "/project/docs",
      path: "roadmap.md",
      projectPath: "/project",
    });
    expect(calls).toEqual(["converted:roadmap/README.md:true"]);

    await run("Duplicate");
    expect(calls).toEqual(["duplicate:roadmap.md"]);
    await run("Delete");
    expect(calls).toEqual(["delete:roadmap.md"]);

    detailState = { form: "folder", subpageCount: 0, otherFileCount: 0 };
    await render("guide/README.md", { menuKind: { kind: "page" }, pinItem });
    const folderNest = await run("Nest page");
    expect(folderNest.includes("convert_page_to_folder")).toBe(false);
    expect(
      commands.find(([command]) => command === "create_page")?.[1].parentPath,
    ).toBe("guide");
    await run("New folder");
    expect(
      commands.find(([command]) => command === "create_folder")?.[1].parentPath,
    ).toBe("guide");
    expect(calls).toEqual([]);
    await run("Make regular page");
    expect(
      commands.some(([command]) => command === "convert_page_to_leaf"),
    ).toBe(true);
    expect(calls).toEqual(["converted:roadmap.md:false"]);

    detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
    await render(".templates/bug.md", {
      menuKind: { kind: "template", isDefault: false },
      pinItem: null,
    });
    await run("Set as default");
    expect(calls).toEqual(["default:true"]);
    await run("Duplicate template");
    expect(calls).toEqual(["duplicate:.templates/bug.md"]);
  });

  test("Rename focuses the header title with its text selected", async () => {
    detailState = { form: "leaf", subpageCount: 0, otherFileCount: 0 };
    await render("roadmap.md", { menuKind: { kind: "page" }, pinItem });
    const title = document.querySelector<HTMLInputElement>(
      "[data-page-title-input]",
    )!;
    await openMenu();
    await select("Rename");
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(title);
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, 7]);

    commands.length = 0;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(title, "Roadmap 2028");
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      title.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }),
      );
    });
    await settle();
    expect(
      commands.find(([command]) => command === "update_page_field")?.[1],
    ).toEqual({
      space: "/project/docs",
      filePath: "roadmap.md",
      field: "title",
      value: "Roadmap 2028",
      projectPath: "/project",
    });
    expect(document.activeElement === title).toBe(false);

    await openMenu();
    await select("Rename");
    await settle();
    expect(document.activeElement).toBe(title);
    commands.length = 0;
    await act(async () => {
      title.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    await settle();
    expect(commands.some(([command]) => command === "update_page_field")).toBe(
      false,
    );
    expect(document.activeElement === title).toBe(false);
    await act(async () => root.unmount());
  });
}
