import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_ALL_PROJECTS_ROW_DOM !== "1") {
  test("all projects sidebar row DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ALL_PROJECTS_ROW_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  );
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
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: dom.window.getComputedStyle,
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
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const calls = { guard: 0, home: 0, navigate: 0 };
  let allowNavigation = true;
  const spaceState = {
    rootSpaces: [],
    activeRootId: "root",
    activeRootName: "Project",
    activeRootIcon: null,
    goHome: () => calls.home++,
  };
  mock.module("@tanstack/react-router", () => ({
    useNavigate: () => () => calls.navigate++,
  }));
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (state: unknown) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));
  mock.module("@/features/space/ui/nav-spaces", () => ({
    NavSpaces: () => null,
  }));
  mock.module("@/features/home", () => ({
    RootProjectDialogs: () => null,
    useRootProjectWorkflow: () => ({
      handleOpenProjectFolder() {},
      openProject() {},
      setCloneDialogOpen() {},
      setCreateDialogOpen() {},
    }),
  }));
  mock.module("./navigation-guards", () => ({
    passNavigationGuards: async () => {
      calls.guard++;
      return allowNavigation;
    },
  }));

  const { SpaceSidebar } = await import("@/features/space/app-shell");
  const { SidebarMenuItem, SidebarProvider } = await import(
    "@/components/ui/sidebar"
  );
  const { AllProjectsSidebarRow } = await import("./all-projects-sidebar-row");
  const { ProjectSwitcher } = await import("./project-switcher");
  const doc = dom.window.document;
  const root = createRoot(doc.getElementById("app")!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  function setPlatform(mac: boolean) {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: mac ? "MacIntel" : "Win32",
    });
  }
  async function render() {
    await act(async () => {
      root.render(
        <SidebarProvider>
          <SpaceSidebar
            userMenu={null}
            onActivateContent={() => {}}
            onBeforeNavigation={async () => true}
            onOpenSearch={() => {}}
            allProjectsItem={<AllProjectsSidebarRow />}
            newSessionItem={
              <SidebarMenuItem data-new-session>New session</SidebarMenuItem>
            }
          />
          <ProjectSwitcher />
        </SidebarProvider>,
      );
      await settle();
    });
  }
  function topRows() {
    return [
      ...doc.querySelectorAll<HTMLElement>(
        '[data-sidebar="content"] [data-sidebar="menu-item"]',
      ),
    ];
  }
  function row() {
    return topRows()[0];
  }
  function rowButton() {
    return row().querySelector<HTMLButtonElement>("button")!;
  }
  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await settle();
    });
  }

  test("All projects leads the space sidebar and reveals the way up with ⌘0", async () => {
    setPlatform(true);
    await render();
    const rows = topRows();
    expect(rows[0].textContent?.includes("All projects")).toBe(true);
    expect(rows[1].hasAttribute("data-new-session")).toBe(true);
    expect(rows[2].textContent?.includes("Search")).toBe(true);

    const button = rowButton();
    expect(button.textContent).toBe("All projects");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+0");
    const [house, arrow] = [...button.querySelectorAll("svg")];
    expect(house.classList.contains("lucide-arrow-left")).toBe(false);
    for (const reveal of ["hover", "focus-within"]) {
      expect(house.classList.contains(`group-${reveal}/menu-item:hidden`)).toBe(
        true,
      );
      expect(arrow.classList.contains(`group-${reveal}/menu-item:block`)).toBe(
        true,
      );
    }
    expect(arrow.classList.contains("hidden")).toBe(true);
    expect(arrow.classList.contains("lucide-arrow-left")).toBe(true);

    const hint = row().querySelector('[data-sidebar="menu-badge"]')!;
    expect(hint.textContent).toBe("⌘0");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    for (const name of [
      "opacity-0",
      "motion-reduce:transition-none",
      "group-hover/menu-item:opacity-100",
      "group-focus-within/menu-item:opacity-100",
    ]) {
      expect(hint.classList.contains(name)).toBe(true);
    }
  });

  test("the row goes Home only past the navigation guards", async () => {
    setPlatform(true);
    await render();
    allowNavigation = false;
    await click(rowButton());
    expect(calls).toEqual({ guard: 1, home: 0, navigate: 0 });
    allowNavigation = true;
    await click(rowButton());
    expect(calls).toEqual({ guard: 2, home: 1, navigate: 1 });
  });

  test("the project switcher item shows ⌘0 and goes Home through the guards", async () => {
    setPlatform(true);
    await render();
    const trigger = doc.querySelector<HTMLButtonElement>(
      '[data-slot="dropdown-menu-trigger"]',
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    const item = doc.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(item.textContent).toBe("All projects⌘0");
    expect(
      item.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent,
    ).toBe("⌘0");
    const before = { ...calls };
    await click(item);
    expect(calls).toEqual({
      guard: before.guard + 1,
      home: before.home + 1,
      navigate: before.navigate + 1,
    });
  });

  test("Windows and Linux name the shortcut Ctrl+0", async () => {
    setPlatform(false);
    await render();
    expect(rowButton().getAttribute("aria-keyshortcuts")).toBe("Control+0");
    expect(
      row().querySelector('[data-sidebar="menu-badge"]')!.textContent,
    ).toBe("Ctrl+0");
  });
}
