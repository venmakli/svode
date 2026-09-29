import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type * as DropdownMenuModule from "./dropdown-menu";

type TriggerProps = ComponentProps<
  typeof DropdownMenuModule.DropdownMenuTrigger
>;
type MenuProps = ComponentProps<typeof DropdownMenuModule.DropdownMenu>;

// Radix picks its layout effect when first imported, so the menu module is
// loaded in a separate process after the DOM globals exist.
const isChild = process.env.SVODE_DROPDOWN_MENU_DOM === "1";

if (!isChild) {
  test("dropdown menu trigger DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DROPDOWN_MENU_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
}

const scenario: typeof test = isChild ? test : () => undefined;

async function renderMenu(
  triggerProps: TriggerProps = {},
  menuProps: MenuProps = {},
) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } = await import("./dropdown-menu");
  const root = createRoot(dom.window.document.getElementById("app")!);
  await act(async () => {
    root.render(
      <DropdownMenu {...menuProps}>
        <DropdownMenuTrigger {...triggerProps}>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  });
  const document = dom.window.document;
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-slot="dropdown-menu-trigger"]',
  )!;

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  // Events of one user action are dispatched in the same task, as browsers do.
  const dispatch = async (...events: Event[]) => {
    await act(async () => {
      for (const event of events) trigger.dispatchEvent(event);
    });
    await settle();
    await settle();
  };
  const click = (detail: number) =>
    new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail,
    });
  const keyboard = (type: string, key: string) =>
    new dom.window.KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key,
    });

  return {
    // A bare click with detail 0 is what AXPress and VO+Space deliver.
    bareClick: () => dispatch(click(0)),
    pointerClick: () =>
      dispatch(
        new dom.window.PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
        new dom.window.PointerEvent("pointerup", { bubbles: true, button: 0 }),
        click(1),
      ),
    // Enter clicks during keydown, Space clicks right after keyup.
    key: (key: string, withClick: boolean) =>
      key === "Enter"
        ? dispatch(keyboard("keydown", key), ...(withClick ? [click(0)] : []))
        : dispatch(
            keyboard("keydown", key),
            keyboard("keyup", key),
            ...(withClick ? [click(0)] : []),
          ),
    menu: () => document.querySelector('[role="menu"]'),
    itemLabels: () =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent,
      ),
    document,
    trigger,
    settle,
    cleanup: async () => {
      await act(async () => root.unmount());
      await settle();
      restoreGlobals();
      dom.window.close();
    },
  };
}

scenario("a bare click toggles the menu open and closed", async () => {
  const menu = await renderMenu();
  try {
    await menu.bareClick();
    expect(menu.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu.menu() === null).toBe(false);
    expect(menu.itemLabels()).toEqual(["Edit", "Delete"]);

    await menu.bareClick();
    expect(menu.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(menu.menu()).toBeNull();
  } finally {
    await menu.cleanup();
  }
});

scenario("a pointer click toggles the menu exactly once", async () => {
  const menu = await renderMenu();
  try {
    await menu.pointerClick();
    expect(menu.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu.menu() === null).toBe(false);
  } finally {
    await menu.cleanup();
  }
});

scenario(
  "Enter and Space followed by the generated click open the menu once",
  async () => {
    for (const key of ["Enter", " "]) {
      const menu = await renderMenu();
      try {
        await menu.key(key, true);
        expect(menu.trigger.getAttribute("aria-expanded")).toBe("true");
        expect(menu.menu() === null).toBe(false);
      } finally {
        await menu.cleanup();
      }
    }
  },
);

scenario(
  "a key press that produces no click leaves the next bare click working",
  async () => {
    const menu = await renderMenu({}, { modal: false });
    try {
      await menu.key(" ", false);
      expect(menu.trigger.getAttribute("aria-expanded")).toBe("true");

      await menu.bareClick();
      expect(menu.trigger.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await menu.cleanup();
    }
  },
);

scenario(
  "Escape closes a menu opened by a bare click and returns focus to the trigger",
  async () => {
    const menu = await renderMenu();
    try {
      await menu.bareClick();
      const content = menu.menu()!;
      await act(async () => {
        content.dispatchEvent(
          new menu.document.defaultView!.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Escape",
          }),
        );
      });
      await menu.settle();
      await menu.settle();
      expect(menu.menu()).toBeNull();
      expect(menu.document.activeElement).toBe(menu.trigger);
    } finally {
      await menu.cleanup();
    }
  },
);

scenario(
  "consumer preventDefault and a disabled trigger keep the menu closed",
  async () => {
    const prevented = await renderMenu({
      onClick: (event) => event.preventDefault(),
    });
    try {
      await prevented.bareClick();
      expect(prevented.menu()).toBeNull();
    } finally {
      await prevented.cleanup();
    }

    const disabled = await renderMenu({ disabled: true });
    try {
      await disabled.bareClick();
      expect(disabled.menu()).toBeNull();
    } finally {
      await disabled.cleanup();
    }
  },
);

scenario(
  "a bare click opens a controlled non-modal menu through its owner",
  async () => {
    const changes: boolean[] = [];
    const menu = await renderMenu(
      {},
      { modal: false, open: false, onOpenChange: (open) => changes.push(open) },
    );
    try {
      await menu.bareClick();
      expect(changes).toEqual([true]);
    } finally {
      await menu.cleanup();
    }
  },
);

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
