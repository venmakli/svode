import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

// Radix picks its layout effect when first imported, so the menu module is
// loaded in a separate process after the DOM globals exist.
const isChild = process.env.SVODE_CONTEXT_MENU_DOM === "1";

if (!isChild) {
  test("context menu item DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CONTEXT_MENU_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
}

const scenario = (isChild ? test : () => undefined) as typeof test;

type MenuModule = typeof import("./context-menu");

async function renderMenu(items: (menu: MenuModule) => ReactNode) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const menuModule = await import("./context-menu");
  const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = menuModule;
  const root = createRoot(dom.window.document.getElementById("app")!);
  await act(async () => {
    root.render(
      <ContextMenu>
        <ContextMenuTrigger>Row</ContextMenuTrigger>
        <ContextMenuContent>{items(menuModule)}</ContextMenuContent>
      </ContextMenu>,
    );
  });
  const document = dom.window.document;
  const trigger = document.querySelector<HTMLElement>(
    '[data-slot="context-menu-trigger"]',
  )!;

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  // Events of one user action are dispatched in the same task, as browsers do.
  const dispatch = async (target: Element, ...events: Event[]) => {
    await act(async () => {
      for (const event of events) target.dispatchEvent(event);
    });
    await settle();
    await settle();
  };
  const pointer = (type: string, button: number) =>
    new dom.window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button,
      pointerType: "mouse",
    });
  const click = () =>
    new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
  const item = (label: string) =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
      ),
    ).find((element) => element.textContent === label)!;

  return {
    menu: () => document.querySelector('[role="menu"]'),
    open: () =>
      dispatch(
        trigger,
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        }),
      ),
    // The pointerdown of the left button is lost; pointerup and the native
    // click still arrive (the sequence captured in DF-278).
    lostPointerDownClick: (label: string) =>
      dispatch(item(label), pointer("pointerup", 0), click()),
    pointerClick: (label: string) =>
      dispatch(
        item(label),
        pointer("pointerdown", 0),
        pointer("pointerup", 0),
        click(),
      ),
    // Press the right button on the row, move to the item and release there:
    // no pointerdown on the item and no click for the right button.
    rightButtonRelease: (label: string) =>
      dispatch(item(label), pointer("pointerup", 2)),
    key: (label: string, key: string) =>
      dispatch(
        item(label),
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        }),
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      await settle();
      restoreGlobals();
      dom.window.close();
    },
  };
}

scenario(
  "a pointerup without pointerdown followed by the native click selects once",
  async () => {
    const selects: string[] = [];
    const clicks: string[] = [];
    const checks: boolean[] = [];
    const radios: string[] = [];
    const render = () =>
      renderMenu(
        ({
          ContextMenuCheckboxItem,
          ContextMenuItem,
          ContextMenuRadioGroup,
          ContextMenuRadioItem,
        }) => (
          <>
            <ContextMenuItem onSelect={() => selects.push("Duplicate")}>
              Duplicate
            </ContextMenuItem>
            <ContextMenuItem onClick={() => clicks.push("Turn into")}>
              Turn into
            </ContextMenuItem>
            <ContextMenuCheckboxItem
              checked={false}
              onCheckedChange={(checked) => checks.push(checked)}
            >
              Pinned
            </ContextMenuCheckboxItem>
            <ContextMenuRadioGroup
              value="a"
              onValueChange={(value) => radios.push(value)}
            >
              <ContextMenuRadioItem value="b">Option B</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </>
        ),
      );

    for (const label of ["Duplicate", "Turn into", "Pinned", "Option B"]) {
      const menu = await render();
      try {
        await menu.open();
        expect(menu.menu() === null).toBe(false);
        await menu.lostPointerDownClick(label);
        expect(menu.menu()).toBeNull();
      } finally {
        await menu.cleanup();
      }
    }

    expect(selects).toEqual(["Duplicate"]);
    expect(clicks).toEqual(["Turn into"]);
    expect(checks).toEqual([true]);
    expect(radios).toEqual(["b"]);
  },
);

scenario(
  "a pointer click, Enter, Space and the right-button release select once",
  async () => {
    const selects: string[] = [];
    const steps: [string, (menu: Awaited<ReturnType<typeof renderMenu>>) => Promise<void>][] = [
      ["click", (menu) => menu.pointerClick("Duplicate")],
      ["Enter", (menu) => menu.key("Duplicate", "Enter")],
      ["Space", (menu) => menu.key("Duplicate", " ")],
      ["release", (menu) => menu.rightButtonRelease("Duplicate")],
    ];

    for (const [name, step] of steps) {
      const menu = await renderMenu(({ ContextMenuItem }) => (
        <ContextMenuItem onSelect={() => selects.push(name)}>
          Duplicate
        </ContextMenuItem>
      ));
      try {
        await menu.open();
        await step(menu);
        expect(menu.menu()).toBeNull();
      } finally {
        await menu.cleanup();
      }
    }

    expect(selects).toEqual(["click", "Enter", "Space", "release"]);
  },
);

scenario("preventDefault in onSelect keeps the menu open", async () => {
  let selects = 0;
  const menu = await renderMenu(({ ContextMenuItem }) => (
    <ContextMenuItem
      onSelect={(event) => {
        selects += 1;
        event.preventDefault();
      }}
    >
      Duplicate
    </ContextMenuItem>
  ));
  try {
    await menu.open();
    await menu.lostPointerDownClick("Duplicate");
    expect(selects).toBe(1);
    expect(menu.menu() === null).toBe(false);

    await menu.pointerClick("Duplicate");
    expect(selects).toBe(2);
    expect(menu.menu() === null).toBe(false);
  } finally {
    await menu.cleanup();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.PointerEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
