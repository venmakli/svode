import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_MAIN_BREADCRUMBS_DOM !== "1") {
  test("main breadcrumbs DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_MAIN_BREADCRUMBS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
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

  const calls = {
    guard: 0,
    pages: [] as [string, string | undefined][],
    spaces: [] as string[],
    cleared: 0,
  };
  let allowNavigation = true;
  mock.module("@/features/page/navigation", () => ({
    useOpenPage: () => (path: string, spaceId?: string) =>
      calls.pages.push([path, spaceId]),
  }));

  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const artifact = await import("@/features/artifact");
  const { useSpaceStore } = await import("../model");
  const { MainBreadcrumbs, SpaceBreadcrumbs } =
    await import("./main-breadcrumbs");
  const m = await import("@/paraglide/messages.js");
  const root = createRoot(document.getElementById("app")!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  const space = (id: string, name: string, icon = "") => ({
    id,
    name,
    icon,
    description: "",
    path: `/project/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready" as const,
    lfsState: "n/a" as const,
  });
  const tree = (title: string) => [
    {
      name: "a",
      path: "a/README.md",
      title,
      icon: "🅰️",
      has_changes: false,
      has_schema: false,
      children: [],
    },
  ];

  function setProject(spaces: ReturnType<typeof space>[]) {
    useSpaceStore.setState({
      activeRootId: "root",
      activeRootName: "Svode",
      activeRootIcon: "🚀",
      activeRootPath: "/project",
      activeSpaceId: null,
      spaces,
      fileTrees: { root: tree("Alpha"), docs: tree("Docs alpha") },
      openSpace: async (id: string) => {
        calls.spaces.push(id);
      },
      clearActiveSpace: () => {
        calls.cleared++;
      },
    });
  }
  async function reset() {
    await act(async () => root.render(null));
    calls.guard = 0;
    calls.pages = [];
    calls.spaces = [];
    calls.cleared = 0;
    allowNavigation = true;
  }

  const guard = async () => {
    calls.guard++;
    return allowNavigation;
  };
  async function render(
    node: React.ReactNode,
    { sidebarOpen = true }: { sidebarOpen?: boolean } = {},
  ) {
    await act(async () => {
      root.render(
        <SidebarProvider defaultOpen={sidebarOpen}>{node}</SidebarProvider>,
      );
    });
    await act(settle);
  }
  const items = () => [
    ...document.querySelectorAll<HTMLElement>("[data-slot=breadcrumb-item]"),
  ];
  const texts = () => items().map((item) => item.textContent);
  const menuItems = () => [
    ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
  ];
  const click = (element: Element) =>
    act(async () => {
      (element as HTMLElement).click();
      await settle();
    });
  const press = (element: Element) =>
    act(async () => {
      element.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      await settle();
    });
  const closeMenus = () =>
    act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await settle();
    });
  const openedSpaceHome = () => {
    const selection = artifact.getActiveContentSelection().selection;
    return selection?.kind === "scope-owner" &&
      selection.request.owner.kind === "space"
      ? selection.request.owner.spaceId
      : null;
  };

  test("a long path folds its middle into a menu of the hidden segments", async () => {
    await reset();
    setProject([space("docs", "Docs", "📚")]);
    artifact.openArtifact({
      path: "a/b/c/d/e.md",
      sourceShape: "file",
      spaceId: "root",
    });
    await render(<MainBreadcrumbs home={false} onBeforeNavigation={guard} />);

    expect(texts()).toEqual(["🅰️Alpha", "More", "d", "e"]);
    expect(items().at(-1)?.querySelector("[aria-current=page]") !== null).toBe(
      true,
    );
    const ellipsis = document.querySelector<HTMLElement>(
      `[aria-label="${m.space_breadcrumb_hidden_path()}"]`,
    )!;
    expect(ellipsis.getAttribute("data-slot")).toBe("dropdown-menu-trigger");

    await press(ellipsis);
    expect(menuItems().map((item) => item.textContent)).toEqual(["b", "c"]);
    expect(
      menuItems().every((item) => item.querySelector("svg") !== null),
    ).toBe(true);

    allowNavigation = false;
    await click(menuItems()[1]);
    expect(calls.pages).toEqual([]);
    allowNavigation = true;
    await press(ellipsis);
    await click(menuItems()[1]);
    expect(calls.guard).toBe(2);
    expect(calls.pages).toEqual([["a/b/c/README.md", "root"]]);
  });

  test("every element but the last opens its object past the guards", async () => {
    await reset();
    setProject([space("docs", "Docs", "📚")]);
    artifact.openArtifact({
      path: "a/b.md",
      sourceShape: "file",
      spaceId: "root",
    });
    await render(<MainBreadcrumbs home={false} onBeforeNavigation={guard} />);

    expect(texts()).toEqual(["🅰️Alpha", "b"]);
    const [first, last] = items();
    expect(last.querySelector("button")).toBe(null);
    allowNavigation = false;
    await click(first.querySelector("button")!);
    expect(calls.pages).toEqual([]);
    allowNavigation = true;
    await click(first.querySelector("button")!);
    expect(calls.pages).toEqual([["a/README.md", "root"]]);
  });

  test("Home starts with the project, which opens the project root home", async () => {
    await reset();
    setProject([space("docs", "Docs", "📚"), space("ops", "Ops")]);
    useSpaceStore.setState({ activeSpaceId: "docs" });
    artifact.openArtifact({
      path: "a/b.md",
      sourceShape: "file",
      spaceId: "docs",
    });
    await render(<MainBreadcrumbs home onBeforeNavigation={guard} />);

    expect(texts()).toEqual(["🚀Svode", "📚Docs", "🅰️Docs alpha", "b"]);
    await click(items()[0].querySelector("button")!);
    expect(calls.cleared).toBe(1);
    expect(openedSpaceHome()).toBe("root");
  });

  test("the Space element first opens its Space home", async () => {
    await reset();
    setProject([space("docs", "Docs", "📚"), space("ops", "Ops")]);
    artifact.openArtifact({
      path: "a/b.md",
      sourceShape: "file",
      spaceId: "docs",
    });
    await render(<MainBreadcrumbs home={false} onBeforeNavigation={guard} />);

    expect(texts()).toEqual(["📚Docs", "🅰️Docs alpha", "b"]);
    await click(items()[0].querySelector("button")!);
    expect(calls.spaces).toEqual(["docs"]);
    expect(openedSpaceHome()).toBe("docs");
    expect(texts()).toEqual(["📚Docs"]);
  });

  for (const sidebarOpen of [true, false]) {
    test(`on its open Space home the Space element lists the Spaces (sidebar ${sidebarOpen ? "expanded" : "collapsed"})`, async () => {
      await reset();
      setProject([space("docs", "Docs", "📚"), space("ops", "Ops")]);
      artifact.openScopeOwner({ kind: "space", spaceId: "docs" });
      await render(
        <MainBreadcrumbs home={false} onBeforeNavigation={guard} />,
        {
          sidebarOpen,
        },
      );

      expect(texts()).toEqual(["📚Docs"]);
      const trigger = items()[0].querySelector<HTMLElement>(
        "[data-slot=dropdown-menu-trigger]",
      )!;
      await click(trigger);
      expect(menuItems().map((item) => item.textContent)).toEqual([
        "📚Docs",
        "📂Ops",
      ]);
      await click(menuItems()[1]);
      expect(calls.guard).toBe(1);
      expect(calls.spaces).toEqual(["ops"]);
      expect(openedSpaceHome()).toBe("ops");
      await closeMenus();
    });

    test(`with one Space its open Space home element does nothing (sidebar ${sidebarOpen ? "expanded" : "collapsed"})`, async () => {
      await reset();
      setProject([space("docs", "Docs", "📚")]);
      artifact.openScopeOwner({ kind: "space", spaceId: "docs" });
      await render(
        <MainBreadcrumbs home={false} onBeforeNavigation={guard} />,
        {
          sidebarOpen,
        },
      );

      expect(texts()).toEqual(["📚Docs"]);
      expect(items()[0].querySelector("button")).toBe(null);
      expect(items()[0].querySelector("[aria-current=page]") !== null).toBe(
        true,
      );
    });
  }

  test("the project root home has no breadcrumbs inside the project", async () => {
    await reset();
    setProject([space("docs", "Docs")]);
    artifact.openScopeOwner({ kind: "space", spaceId: "root" });
    await render(<MainBreadcrumbs home={false} onBeforeNavigation={guard} />);
    expect(document.querySelector("[data-slot=breadcrumb]")).toBe(null);

    await render(<MainBreadcrumbs home onBeforeNavigation={guard} />);
    expect(texts()).toEqual(["🚀Svode"]);
    expect(items()[0].querySelector("button")).toBe(null);
  });

  test("another surface passes the prefix before its own current element", async () => {
    await reset();
    setProject([space("docs", "Docs", "📚")]);
    let activated = 0;
    const current = <span data-testid="current">Session</span>;
    await render(
      <SpaceBreadcrumbs
        home
        spacePath="/project/docs"
        current={current}
        onBeforeNavigation={guard}
        onActivateContent={() => activated++}
      />,
    );
    expect(texts()).toEqual(["🚀Svode", "📚Docs", "Session"]);
    await click(items()[1].querySelector("button")!);
    expect(activated).toBe(1);
    expect(calls.spaces).toEqual(["docs"]);

    await render(
      <SpaceBreadcrumbs
        home={false}
        spacePath="/project"
        current={current}
        onBeforeNavigation={guard}
      />,
    );
    expect(texts()).toEqual(["Session"]);
  });
}
