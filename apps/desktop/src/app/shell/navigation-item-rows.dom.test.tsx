import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_NAVIGATION_ITEM_ROWS_DOM !== "1") {
  test("navigation item rows DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_NAVIGATION_ITEM_ROWS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
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

  type Item = { key: Record<string, string>; title: string };
  const pinned: Item[] = [];
  const kept: Item[] = [];
  const commands: [string, unknown][] = [];
  const state = () => ({ pinned: [...pinned], kept: [...kept] });
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        commands.push([command, args.item]);
        if (command === "navigation_read") return state();
        if (command === "navigation_keep") {
          kept.push(args.item as Item);
          return state();
        }
        if (command === "navigation_pin") {
          kept.splice(0);
          pinned.push(args.item as Item);
          return state();
        }
        return state();
      },
    },
  });

  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const spaceState = {
    activeRootId: "root",
    activeRootName: "Svode",
    activeRootPath: "/project",
    activeSpaceId: null,
    spaces: [],
    openSpace: async () => undefined,
    clearActiveSpace: () => undefined,
  };
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
    getSpaceSnapshot: () => spaceState,
  }));

  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const navigation = await import("@/features/navigation");
  const artifact = await import("@/features/artifact");
  const { NavigationArtifactItem, useOpenNavigationArtifact } =
    await import("./navigation-sidebar-items");
  const { TemporaryItem } = await import("./now-sidebar-section");
  const m = await import("@/paraglide/messages.js");

  navigation.getNavigationState().setProject("/project");

  const routine: import("@/features/navigation").NavigationResolvedItem = {
    key: {
      kind: "routine",
      ownerKind: "collection",
      ownerPath: "tasks",
      routineId: "daily",
    },
    title: "Daily",
  };
  const root = createRoot(document.getElementById("app")!);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  async function render(node: React.ReactNode) {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>{node}</SidebarProvider>
        </TooltipProvider>,
      ),
    );
    await settle();
  }
  const button = (label: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label='${label}']`);
  const rowText = () =>
    document.querySelector("[data-sidebar=menu-button]")?.textContent;

  test("the temporary row of an expanded item keeps it in Now, and the kept row pins it", async () => {
    await render(
      <TemporaryItem
        temporary={{ item: routine, keepItem: routine, session: null }}
        mainTarget={null}
        onClose={() => undefined}
      />,
    );
    expect(rowText()?.startsWith("Daily")).toBe(true);
    await act(async () =>
      button(m.navigation_keep_item({ title: "Daily" }))!.click(),
    );
    await settle();
    expect(commands.at(-1)).toEqual(["navigation_keep", routine]);

    await render(
      <NavigationArtifactItem
        item={navigation.getNavigationState().kept[0]}
        active
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
    await act(async () =>
      button(m.navigation_pin_item({ title: "Daily" }))!.click(),
    );
    await settle();
    expect(commands.at(-1)).toEqual(["navigation_pin", routine]);
    expect(navigation.getNavigationState().pinned).toEqual([routine]);
  });

  test("a row shows the name and icon its domain gives the item, else the last known name", async () => {
    await render(
      <NavigationArtifactItem
        item={routine}
        active={false}
        onOpen={() => undefined}
      />,
    );
    expect(rowText()).toBe("Daily");
    await act(async () =>
      navigation.publishNavigationItemDisplays(
        new Map([
          [
            navigation.navigationKeyId(routine.key as never),
            { title: "Daily standup", icon: <span data-domain-icon /> },
          ],
        ]),
      ),
    );
    expect(rowText()).toBe("Daily standup");
    expect(document.querySelector("[data-domain-icon]") === null).toBe(false);
  });

  test("an item row opens the item expanded over its owner", async () => {
    let open: ((item: typeof routine) => Promise<void>) | null = null;
    function Opener() {
      const current = useOpenNavigationArtifact({
        onActivateContent: () => undefined,
        onBeforeNavigation: async () => true,
      });
      useEffect(() => {
        open = current as never;
      });
      return null;
    }
    await render(<Opener />);
    await act(async () => open!(routine));
    await settle();
    const selection = artifact.getActiveContentSelection().selection;
    expect(selection?.kind).toBe("scope-owner");
    expect(
      selection?.kind === "scope-owner"
        ? [selection.request.owner, selection.request.intent]
        : null,
    ).toEqual([
      { kind: "collection", path: "tasks", spaceId: "root" },
      { kind: "item", item: { surfaceId: "routines", itemId: "daily" } },
    ]);
    await act(async () => root.render(null));
  });
}
