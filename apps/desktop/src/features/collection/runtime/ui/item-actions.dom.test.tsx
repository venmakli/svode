import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";

import type { CollectionItemActionDescriptor } from "../model/types";

// DF-314: an owner action in the row actions menu and in the row context
// menu shows its message, a disabled reason, an owner error or a refused
// run, as a second muted line under its label, as content actions in the
// same menu show their reason. Radix menus need the DOM before they load,
// so the cases run in an isolated process.
if (process.env.SVODE_COLLECTION_ITEM_ACTIONS_DOM !== "1") {
  test("Collection item action menus DOM in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ITEM_ACTIONS_DOM: "1" },
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
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    SVGElement: dom.window.SVGElement,
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
    DOMRect:
      dom.window.DOMRect ??
      class {
        static fromRect(rect: Partial<DOMRect> = {}) {
          return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            ...rect,
          };
        }
      },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
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
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  const { createRoot } = await import("react-dom/client");
  const { ContextMenu, ContextMenuContent, ContextMenuTrigger } =
    await import("@/components/ui/context-menu");
  const {
    CollectionItemActionsContextMenu,
    CollectionItemActionsDropdownMenu,
  } = await import("./item-actions");

  const REASON = "Choose an executor to run the routine.";
  const OWNER_ERROR = "The last run was refused.";
  const REFUSAL = "The agent is not installed.";

  interface Item {
    id: string;
  }
  const item: Item = { id: "review" };
  let runs: string[] = [];
  let rejected: [string, string][] = [];

  const action = (
    id: string,
    getState: CollectionItemActionDescriptor<Item>["getState"],
    run: CollectionItemActionDescriptor<Item>["run"] = () => {
      runs.push(id);
    },
  ) =>
    ({
      id,
      label: `Action ${id}`,
      getState,
      run,
    }) as CollectionItemActionDescriptor<unknown>;

  const actions = [
    action("disabled", () => ({ status: "disabled", reason: REASON })),
    action("error", () => ({ status: "error", message: OWNER_ERROR })),
    action("plain", () => ({ status: "idle" })),
    action("empty", () => ({ status: "disabled", reason: "" })),
    action(
      "refused",
      () => ({ status: "idle" }),
      () => Promise.reject(new Error(REFUSAL)),
    ),
  ];
  const onRejected = (actionId: string, message: string) => {
    rejected.push([actionId, message]);
  };

  let root: ReturnType<typeof createRoot> | null = null;
  async function render(node: ReactNode) {
    await act(async () => root?.unmount());
    runs = [];
    rejected = [];
    root = createRoot(document.getElementById("app")!);
    await act(async () => root!.render(node));
  }

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openDropdown() {
    await render(
      <CollectionItemActionsDropdownMenu
        actions={actions}
        item={item}
        onRejected={onRejected}
      />,
    );
    const trigger = document.querySelector<HTMLElement>(
      "button[aria-haspopup=menu]",
    )!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();
    return "[data-slot=dropdown-menu-content]";
  }

  async function openContextMenu() {
    await render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-row>Team review</div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <CollectionItemActionsContextMenu
            actions={actions}
            item={item}
            onRejected={onRejected}
          />
        </ContextMenuContent>
      </ContextMenu>,
    );
    await act(async () => {
      document.querySelector("[data-row]")!.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await settle();
    return "[data-slot=context-menu-content]";
  }

  function menuItem(content: string, id: string) {
    const found = document
      .querySelector(content)
      ?.querySelector<HTMLElement>(`[data-collection-action="${id}"]`);
    if (!found) throw new Error(`no item ${id}: ${document.body.innerHTML}`);
    return found;
  }

  /** The muted second line of an item, as it is drawn under the label. */
  function messageLine(element: HTMLElement) {
    return element.querySelector(".text-muted-foreground")?.textContent ?? null;
  }

  /** Text a screen reader gets for the item: its content, title and descriptions. */
  function announced(element: HTMLElement) {
    return [
      element.textContent ?? "",
      element.getAttribute("title") ?? "",
      element.getAttribute("aria-description") ?? "",
      element.getAttribute("aria-label") ?? "",
    ].join(" ");
  }

  const occurrences = (text: string, part: string) =>
    text.split(part).length - 1;

  async function click(element: HTMLElement) {
    await act(async () => {
      element.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }

  for (const [menu, open] of [
    ["dropdown", openDropdown],
    ["context", openContextMenu],
  ] as const) {
    test(`${menu}: a disabled action shows its reason under the label and stays disabled`, async () => {
      const content = await open();
      const disabled = menuItem(content, "disabled");
      expect(disabled.hasAttribute("data-disabled")).toBe(true);
      expect(disabled.getAttribute("aria-disabled")).toBe("true");
      expect(messageLine(disabled)).toBe(REASON);
      expect(disabled.hasAttribute("title")).toBe(false);
      expect(disabled.hasAttribute("aria-description")).toBe(false);
      expect(disabled.querySelector(".sr-only")).toBeNull();
      expect(disabled.textContent).toBe(`Action disabled${REASON}`);
      expect(occurrences(announced(disabled), REASON)).toBe(1);

      await click(disabled);
      expect(runs).toEqual([]);
      expect(document.querySelector(content) !== null).toBe(true);
    });

    test(`${menu}: an owner error shows its message the same way`, async () => {
      const content = await open();
      const error = menuItem(content, "error");
      expect(error.hasAttribute("data-disabled")).toBe(false);
      expect(error.getAttribute("data-collection-action-state")).toBe("error");
      expect(messageLine(error)).toBe(OWNER_ERROR);
      expect(error.hasAttribute("title")).toBe(false);
      expect(error.querySelector(".sr-only")).toBeNull();
      expect(occurrences(announced(error), OWNER_ERROR)).toBe(1);
    });

    test(`${menu}: an action without a message or with an empty reason is its label alone`, async () => {
      const content = await open();
      for (const id of ["plain", "empty"]) {
        const element = menuItem(content, id);
        expect(element.textContent).toBe(`Action ${id}`);
        expect(messageLine(element)).toBeNull();
        expect(element.hasAttribute("title")).toBe(false);
        expect(element.hasAttribute("aria-description")).toBe(false);
      }
      expect(menuItem(content, "empty").hasAttribute("data-disabled")).toBe(
        true,
      );
    });
  }

  test("dropdown: a refused run shows the refusal under the label and keeps the menu open", async () => {
    const content = await openDropdown();
    const refused = menuItem(content, "refused");
    expect(messageLine(refused)).toBeNull();

    await click(refused);
    expect(rejected).toEqual([["refused", REFUSAL]]);
    const after = menuItem(content, "refused");
    expect(after.getAttribute("data-collection-action-state")).toBe("error");
    expect(messageLine(after)).toBe(REFUSAL);
    expect(after.hasAttribute("title")).toBe(false);
    expect(occurrences(announced(after), REFUSAL)).toBe(1);
  });

  test("dropdown: a successful action still closes the menu", async () => {
    const content = await openDropdown();
    await click(menuItem(content, "plain"));
    expect(runs).toEqual(["plain"]);
    expect(document.querySelector(content)).toBeNull();
  });
}
