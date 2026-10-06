import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_HOME_SIDEBAR_DOM !== "1") {
  test("Home sidebar DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_HOME_SIDEBAR_DOM: "1" },
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
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });

  const project = (
    id: string,
    name: string,
    lastOpened: string | null,
    status: "ready" | "missing" = "ready",
  ) => ({
    id,
    name,
    icon: "",
    description: id === "a" ? "Roadmap and specs" : "",
    path: `/projects/${id}`,
    hasSpaces: false,
    hasSchema: false,
    lastOpened,
    status,
    lfsState: "n/a" as const,
  });
  const spaceState = {
    rootSpaces: [
      project("a", "Svode", "2026-10-01T00:00:00Z"),
      project("b", "Svode", "2026-10-05T00:00:00Z"),
      project("c", "Notes", null),
      project("d", "Gone", "2026-09-01T00:00:00Z", "missing"),
    ],
  };
  const calls = {
    open: [] as string[],
    remove: [] as [string, boolean][],
    create: 0,
    copy: [] as string[],
    reveal: [] as string[],
  };
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (state: unknown) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));
  mock.module("@/features/home/hooks/use-root-project-workflow", () => ({
    useRootProjectWorkflow: () => ({
      cloningProject: {
        name: "repo",
        path: "/projects/repo",
        phase: "",
        percent: 40,
      },
      handleOpenProjectFolder() {},
      openProject: async (id: string) => calls.open.push(id),
      handleDeleteProject: async (id: string, deleteFiles: boolean) =>
        calls.remove.push([id, deleteFiles]),
      setCloneDialogOpen() {},
      setCreateDialogOpen: () => calls.create++,
    }),
  }));
  mock.module("@/features/home/ui/root-project-dialogs", () => ({
    RootProjectDialogs: () => null,
  }));
  mock.module("@/features/home/api/home-project-actions", () => ({
    listHomeProjectsInOtherWindows: async () => ["b"],
    listenHomeProjectWindowsChanged: async () => () => {},
    revealHomeProjectFolder: async (path: string) => calls.reveal.push(path),
    copyHomeProjectPath: async (path: string) => calls.copy.push(path),
  }));

  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { HomeSidebar } = await import("./home-sidebar");
  const { useProjectWindowsLifecycle } =
    await import("../hooks/use-home-projects");
  const m = await import("@/paraglide/messages.js");
  const root = createRoot(document.getElementById("app")!);
  const started: string[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  function Lifecycle() {
    useProjectWindowsLifecycle();
    return null;
  }
  const render = async () => {
    await act(async () =>
      root.render(
        <TooltipProvider delayDuration={0}>
          <SidebarProvider>
            <Lifecycle />
            <HomeSidebar
              userMenu={<div data-testid="footer">footer</div>}
              onBeforeNavigation={async () => true}
              onActivateContent={() => {}}
              onStartChat={(item) => started.push(item.id)}
              projectItems={(item, availability) => (
                <li data-testid={`items-${item.id}`}>
                  {`objects of ${item.id}: ${availability}`}
                </li>
              )}
            />
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await act(settle);
  };
  const rowButton = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-sidebar=menu-button]",
      ),
    ].filter((button) => button.textContent?.startsWith(name));
  const press = (target: Element) =>
    act(async () => {
      target.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });

  test("actions, then the projects by last opening with the clone row, then the footer", async () => {
    await render();
    const labels = [
      ...document.querySelectorAll("[data-sidebar=menu-button]"),
    ].map((button) => button.textContent);
    expect(labels.slice(0, 3)).toEqual([
      m.home_create_project(),
      m.home_open_project(),
      m.home_clone_project(),
    ]);
    expect(labels.slice(3)).toEqual(["Svode", "Svode", "Gone", "Notes"]);
    const text = document.body.textContent ?? "";
    const cloning = text.indexOf(`${m.home_cloning()} 40%`);
    expect(text.indexOf(m.home_projects()) < cloning).toBe(true);
    expect(cloning < text.indexOf("Notes")).toBe(true);
    expect(text.indexOf("Notes") < text.indexOf("footer")).toBe(true);
    expect(text.includes(`${m.home_cloning()} 40%`)).toBe(true);
    expect(text.includes("Settings")).toBe(false);
  });

  test("marks the project of another window and keeps others unmarked", async () => {
    await render();
    const [first, second] = rowButton("Svode");
    const mark = `[aria-label='${m.home_project_other_window()}']`;
    expect(first.querySelector(mark) === null).toBe(false);
    expect(second.querySelector(mark)).toBeNull();
  });

  test("the tooltip adds the path when another project has the same name", async () => {
    await render();
    const [, svodeA] = rowButton("Svode");
    await act(async () => svodeA.focus());
    await act(settle);
    const tooltip = document.querySelector("[data-slot=tooltip-content]");
    expect((tooltip?.textContent ?? "").includes("Roadmap and specs")).toBe(
      true,
    );
    expect((tooltip?.textContent ?? "").includes("/projects/a")).toBe(true);
    await act(async () => svodeA.blur());
    const [notes] = rowButton("Notes");
    await act(async () => notes.focus());
    await act(settle);
    const notesTooltip = [
      ...document.querySelectorAll("[data-slot=tooltip-content]"),
    ].at(-1);
    expect((notesTooltip?.textContent ?? "").includes("Notes")).toBe(true);
    expect((notesTooltip?.textContent ?? "").includes("/projects/c")).toBe(
      false,
    );
    const [gone] = rowButton("Gone");
    await act(async () => gone.focus());
    await act(settle);
    const goneTooltip = [
      ...document.querySelectorAll("[data-slot=tooltip-content]"),
    ].at(-1);
    expect(
      (goneTooltip?.textContent ?? "").includes(m.home_project_missing()),
    ).toBe(true);
  });

  test("the row enters the project, its button starts a chat", async () => {
    await render();
    const [notes] = rowButton("Notes");
    await act(async () => notes.click());
    expect(calls.open).toEqual(["c"]);
    const start = document.querySelector<HTMLButtonElement>(
      `[aria-label='${m.home_project_start_chat_in({ project: "Notes" })}']`,
    )!;
    await act(async () => start.click());
    expect(started).toEqual(["c"]);
  });

  test("the row menu: start chat, file manager, copy path, then remove with confirmation", async () => {
    await render();
    const trigger = document.querySelector(
      `[aria-label='${m.home_project_actions({ project: "Notes" })}']`,
    )!;
    await press(trigger);
    const items = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      m.home_project_start_chat(),
      m.external_open_reveal_finder(),
      m.home_project_copy_path(),
      m.project_remove(),
    ]);
    expect(document.querySelector("[role=separator]") === null).toBe(false);
    await act(async () => items[2].click());
    expect(calls.copy).toEqual(["/projects/c"]);
    await press(trigger);
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("[role=menuitem]")][1].click(),
    );
    expect(calls.reveal).toEqual(["/projects/c"]);
    await press(trigger);
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("[role=menuitem]")][3].click(),
    );
    await act(settle);
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[role=alertdialog] button",
      ),
    ].find((button) => button.textContent === m.project_delete_confirm())!;
    await act(async () => confirm.click());
    expect(calls.remove).toEqual([["c", false]]);
  });

  test("the chevron expands a project in place and the device keeps it", async () => {
    await render();
    const items = () => document.querySelector("[data-testid=items-c]");
    const chevron = () =>
      document.querySelector<HTMLButtonElement>(
        `[aria-label='${m.home_project_toggle({ project: "Notes" })}']`,
      )!;
    expect(items()).toBeNull();
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    const opened = calls.open.length;
    await act(async () => chevron().click());
    expect(items()?.textContent).toBe("objects of c: available");
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    expect(calls.open.length).toBe(opened);
    // The objects are no part of the project row: hovering one is not
    // hovering the row.
    expect(items()!.closest("[data-sidebar=menu-item]")).toBeNull();
    expect(localStorage.getItem("svode:home-project-expanded:c")).toBe("1");

    await act(async () => root.render(null));
    await render();
    expect(items()?.textContent).toBe("objects of c: available");
    await act(async () => chevron().click());
    expect(items()).toBeNull();
    expect(localStorage.getItem("svode:home-project-expanded:c")).toBeNull();
  });

  test("⌘N opens Create project", async () => {
    await render();
    const before = calls.create;
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyN",
          key: "n",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(calls.create).toBe(before + 1);
  });

  test("the collapsed Projects group stays collapsed on this device", async () => {
    await render();
    const label = [
      ...document.querySelectorAll("[data-sidebar=group-label]"),
    ].find(
      (element) => element.textContent === m.home_projects(),
    ) as HTMLButtonElement;
    await act(async () => label.click());
    expect(
      localStorage.getItem("svode:sidebar-group-collapsed:home-projects"),
    ).toBe("1");
    expect(rowButton("Notes").length).toBe(0);
    await act(async () => root.render(null));
    await render();
    expect(rowButton("Notes").length).toBe(0);
    expect(rowButton(m.home_create_project()).length).toBe(1);
  });
}
