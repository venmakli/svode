import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_NAVIGATION_SIDEBAR_DOM !== "1") {
  test("navigation sidebar DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_NAVIGATION_SIDEBAR_DOM: "1" },
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

  type Item = { key: { kind: string }; title: string };
  const pinned: Item[] = [];
  const kept: Item[] = [];
  const commands: string[] = [];
  const state = () => ({ pinned: [...pinned], kept: [...kept] });
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        commands.push(command);
        if (command === "navigation_read") return state();
        if (command === "navigation_pin") {
          kept.splice(0);
          pinned.push(args.item as Item);
          return state();
        }
        if (command === "navigation_keep") {
          kept.push(args.item as Item);
          return state();
        }
        if (command === "navigation_unpin") {
          pinned.splice(0);
          return state();
        }
        throw new Error(`unexpected command ${command}`);
      },
    },
  });

  const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
    await import("@/components/ui/dropdown-menu");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { getNavigationState } = await import("../hooks/use-navigation-state");
  const { NavigationSidebarGroup } = await import("./navigation-sidebar-group");
  const { NavigationSidebarItem } = await import("./navigation-sidebar-item");
  const { NavigationMenuItems, PinMenuItem } = await import("./pin-controls");
  const { UserEditScope } = await import("./user-edit-scope");
  const { useSignalUserEdit, signalCreatedArtifact } =
    await import("../hooks/use-signal-user-edit");
  const { subscribeUserEdits } = await import("../model/user-edit-signal");

  let root: Root | null = null;
  async function render(node: React.ReactNode) {
    root?.unmount();
    root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root!.render(
        <TooltipProvider>
          <SidebarProvider>{node}</SidebarProvider>
        </TooltipProvider>,
      ),
    );
  }

  test("a group collapses from its label and keeps the choice on this device", async () => {
    const group = (
      <NavigationSidebarGroup id="pinned" label="Pinned">
        <li data-row>row</li>
      </NavigationSidebarGroup>
    );
    await render(group);
    const label = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Pinned",
    )!;
    expect(label.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-row]") === null).toBe(false);

    await act(async () => label.click());
    expect(document.querySelector("[data-row]")).toBeNull();

    await render(group);
    expect(document.querySelector("[data-row]")).toBeNull();
    localStorage.clear();
  });

  test("an unavailable row keeps its title and marker and does not open", async () => {
    let opened = 0;
    const item = (unavailable: boolean, active = false) => (
      <NavigationSidebarItem
        title="Plan"
        icon={null}
        tooltip={null}
        active={active}
        unavailable={unavailable}
        onOpen={() => (opened += 1)}
        menu={null}
      />
    );
    await render(item(true));
    const button = document.querySelector<HTMLButtonElement>(
      "[data-sidebar=menu-button]",
    )!;
    expect(button.textContent).toBe("Plan");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector("[aria-label=Unavailable]") === null).toBe(
      false,
    );
    await act(async () => button.click());
    expect(opened).toBe(0);
    expect(
      document
        .querySelector("[data-sidebar=menu-action]")
        ?.getAttribute("aria-label"),
    ).toBe("Actions for “Plan”");

    await render(item(false, true));
    const current = document.querySelector<HTMLButtonElement>(
      "[data-sidebar=menu-button]",
    )!;
    expect(current.getAttribute("aria-current")).toBe("page");
    await act(async () => current.click());
    expect(opened).toBe(1);
  });

  test("a status marker takes the menu slot and names the status", async () => {
    await render(
      <NavigationSidebarItem
        title="Fix login"
        icon={null}
        status={{ marker: <span data-marker />, label: "Working" }}
        tooltip={null}
        active={false}
        unavailable={false}
        onOpen={() => undefined}
        menu={null}
      />,
    );
    const badge = document.querySelector("[data-sidebar=menu-badge]");
    expect(badge?.querySelector("[data-marker]") === null).toBe(false);
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(
      document.querySelector("[data-sidebar=menu-button]")?.textContent,
    ).toBe("Fix loginWorking");
    expect(
      document.querySelector("[data-sidebar=menu-action]") === null,
    ).toBe(false);
  });

  test("the menu item pins, then unpins, the object", async () => {
    await act(async () => getNavigationState().setProject("/project"));
    const menu = (
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <PinMenuItem
            item={{ key: { kind: "space", spaceId: "docs" }, title: "Docs" }}
          />
          <PinMenuItem item={null} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
    await render(menu);
    const menuItem = () =>
      document.querySelector<HTMLElement>("[role=menuitem]")!;
    expect(document.querySelectorAll("[role=menuitem]").length).toBe(1);
    expect(menuItem().textContent).toBe("Pin");

    await act(async () => menuItem().click());
    expect(commands.includes("navigation_pin")).toBe(true);
    expect(getNavigationState().pinned.map((item) => item.title)).toEqual([
      "Docs",
    ]);

    await render(menu);
    expect(menuItem().textContent).toBe("Unpin");
    await act(async () => menuItem().click());
    expect(commands.includes("navigation_unpin")).toBe(true);
    expect(getNavigationState().pinned).toEqual([]);
    root?.unmount();
  });

  test("keep in Now shows until the object is kept or pinned", async () => {
    await act(async () => getNavigationState().setProject("/project"));
    const menu = (
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <NavigationMenuItems
            item={{ key: { kind: "space", spaceId: "docs" }, title: "Docs" }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const labels = () =>
      [...document.querySelectorAll("[role=menuitem]")].map(
        (item) => item.textContent,
      );
    await render(menu);
    expect(labels()).toEqual(["Pin", "Keep in Now"]);

    const keepItem = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ].find((item) => item.textContent === "Keep in Now")!;
    await act(async () => keepItem.click());
    expect(getNavigationState().kept.map((item) => item.title)).toEqual([
      "Docs",
    ]);
    await render(menu);
    expect(labels()).toEqual(["Pin"]);

    // Pinning a kept object moves it out of Now.
    const pinItem = document.querySelector<HTMLElement>("[role=menuitem]")!;
    await act(async () => pinItem.click());
    expect(getNavigationState().kept).toEqual([]);
    await render(menu);
    expect(labels()).toEqual(["Unpin"]);
    root?.unmount();
  });

  test("a Now row closes by its named button and a temporary row is kept by double click", async () => {
    let closed = 0;
    let keptTimes = 0;
    await render(
      <NavigationSidebarItem
        title="Plan"
        icon={null}
        tooltip={null}
        active
        unavailable={false}
        onOpen={() => undefined}
        menu={null}
        onClose={() => (closed += 1)}
        temporary
        onKeep={() => (keptTimes += 1)}
      />,
    );
    const button = document.querySelector<HTMLButtonElement>(
      "[data-sidebar=menu-button]",
    )!;
    expect(button.className.includes("italic")).toBe(true);
    expect(button.textContent).toBe("PlanTemporarily open");
    const close = document.querySelector<HTMLButtonElement>(
      "[aria-label='Close “Plan”']",
    )!;
    await act(async () => close.click());
    expect(closed).toBe(1);
    await act(async () =>
      button.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
      ),
    );
    expect(keptTimes).toBe(1);
    root?.unmount();
  });

  test("only edits inside the main area signal; a peek inside it does not", async () => {
    const edits: string[] = [];
    const unsubscribe = subscribeUserEdits((edit) =>
      edits.push(
        edit.kind === "edit"
          ? "edit"
          : edit.kind === "created"
            ? `created:${edit.path}`
            : `message:${edit.sessionId}`,
      ),
    );
    function Editor({ id }: { id: string }) {
      const signal = useSignalUserEdit();
      return (
        <button type="button" data-editor={id} onClick={signal}>
          edit
        </button>
      );
    }
    await render(
      <>
        <UserEditScope mainArea>
          <Editor id="main" />
          <UserEditScope mainArea={false}>
            <Editor id="peek" />
          </UserEditScope>
        </UserEditScope>
        <Editor id="elsewhere" />
      </>,
    );
    for (const id of ["peek", "elsewhere", "main"]) {
      await act(async () =>
        document.querySelector<HTMLElement>(`[data-editor=${id}]`)!.click(),
      );
    }
    signalCreatedArtifact("docs", "new.md");
    expect(edits).toEqual(["edit", "created:new.md"]);
    unsubscribe();
    root?.unmount();
  });
}
