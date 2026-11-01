import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CollectionItemPeekController } from "./types";

interface Item {
  id: string;
  name: string;
}

if (process.env.SVODE_COLLECTION_ITEM_PEEK_DOM !== "1") {
  test("collection item peek DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ITEM_PEEK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><button id=row-ada>Ada</button><button id=fallback>Rows</button></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    SVGElement: dom.window.SVGElement,
    DOMRect: dom.window.DOMRect,
    FocusEvent: dom.window.FocusEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
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

  const doc = dom.window.document;

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  /** A block the user expanded inside the screen. */
  function Expandable({ children }: { children: ReactNode }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <div data-expandable={expanded ? "open" : "closed"}>
        <button type="button" onClick={() => setExpanded(true)}>
          Expand
        </button>
        {children}
      </div>
    );
  }

  async function setup(
    initial: readonly Item[],
    options: { guard?: () => boolean | Promise<boolean> } = {},
  ) {
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { defineCollectionPresentation } =
      await import("@/features/collection");
    const { CollectionItemPeek } = await import("./collection-item-peek");
    const { CollectionItemActionsMenu } = await import("./item-actions-menu");
    const { useCollectionItemPeek } =
      await import("./use-collection-item-peek");

    let guardCalls = 0;
    const owner: {
      peek?: CollectionItemPeekController<string>;
      setItems?: (items: readonly Item[] | null) => void;
    } = {};
    const presentation = defineCollectionPresentation<Item>({
      descriptor: {
        getItemId: (item) => item.id,
        id: "people",
        itemActions: [
          {
            getState: () => ({ status: "idle" }),
            id: "share",
            label: "Share",
            run: () => undefined,
          },
        ],
        label: "People",
        layout: {
          getTitle: (item) => item.name,
          kind: "list",
          visibleProperties: [],
        },
        properties: [],
        query: {},
      },
      state: { items: initial, phase: "ready" },
    });

    function Owner() {
      // Null while the source loads or failed to refresh.
      const [items, setItems] = useState<readonly Item[] | null>(initial);
      const peek = useCollectionItemPeek<string>((id) => id);
      useEffect(() => {
        owner.peek = peek;
        owner.setItems = setItems;
      }, [peek]);
      return (
        <CollectionItemPeek
          peek={peek}
          find={(id) => (items ? items.find((item) => item.id === id) : null)}
          render={(item) => ({
            canClose: () => {
              guardCalls += 1;
              return options.guard?.() ?? true;
            },
            content: (
              <Expandable>
                <p data-item-content>{item.name}</p>
              </Expandable>
            ),
            header: { icon: <span>☺</span>, title: item.name },
            identity: { icon: <span>☺</span>, name: item.name },
            menu: (
              <CollectionItemActionsMenu
                item={item}
                presentation={presentation}
              />
            ),
            tools: <button type="button">Run {item.name}</button>,
          })}
        />
      );
    }

    const root = createRoot(doc.body.appendChild(doc.createElement("div")));
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Owner />
        </TooltipProvider>,
      );
    });
    return {
      get guardCalls() {
        return guardCalls;
      },
      async open(id: string, withRow = true) {
        await act(async () => {
          owner.peek!.open(id, {
            fallbackFocus: () => doc.getElementById("fallback"),
            returnFocus: withRow
              ? () => doc.getElementById(`row-${id}`)
              : undefined,
          });
        });
        await settle();
      },
      async setItems(items: readonly Item[] | null) {
        await act(async () => owner.setItems!(items));
        await settle();
      },
      async unmount() {
        await act(async () => root.unmount());
      },
    };
  }

  const topBar = () => doc.querySelector<HTMLElement>("[data-peek-top-bar]");
  const identity = () =>
    doc.querySelector("[data-peek-identity] [title]")?.textContent ?? null;
  const menu = () =>
    topBar()?.querySelector('[aria-label="Row actions"]') ?? null;

  test("identity, ⋯ and tools sit in the top bar above the content header", async () => {
    const env = await setup([{ id: "ada", name: "Ada" }]);
    await env.open("ada");
    expect(identity()).toBe("Ada");
    expect(menu() === null).toBe(false);
    expect(topBar()?.textContent?.includes("Run Ada")).toBe(true);
    expect(doc.querySelector("[data-object-content-header]")?.textContent).toBe(
      "☺Ada",
    );
    expect(doc.querySelector('[role="dialog"] h2')?.textContent).toBe("Ada");
    await env.unmount();
  });

  test("a new version draws in place: no reopening, no guard, same tabs and ⋯", async () => {
    const env = await setup([{ id: "ada", name: "Ada" }]);
    await env.open("ada");
    const content = doc.querySelector("[data-item-content]");
    await act(async () => {
      doc.querySelector<HTMLButtonElement>("[data-expandable] button")!.click();
    });
    await env.setItems([{ id: "ada", name: "Ada Lovelace" }]);
    expect(identity()).toBe("Ada Lovelace");
    expect(doc.querySelector("[data-item-content]")).toBe(content);
    expect(content?.textContent).toBe("Ada Lovelace");
    expect(
      doc.querySelector("[data-expandable]")?.getAttribute("data-expandable"),
    ).toBe("open");
    expect(menu() === null).toBe(false);
    expect(env.guardCalls).toBe(0);
    // A source that is not ready keeps the shown version.
    await env.setItems(null);
    expect(identity()).toBe("Ada Lovelace");
    expect(menu() === null).toBe(false);
    await env.unmount();
  });

  test("another item passes the guard once; a gone item closes with focus at its row or the fallback", async () => {
    const env = await setup([
      { id: "ada", name: "Ada" },
      { id: "grace", name: "Grace" },
    ]);
    await env.open("ada");
    await env.open("grace", false);
    expect(identity()).toBe("Grace");
    expect(env.guardCalls).toBe(1);
    await env.open("ada");
    expect(env.guardCalls).toBe(2);
    await env.setItems([{ id: "grace", name: "Grace" }]);
    expect(doc.querySelector("[data-collection-item-peek]")).toBeNull();
    expect(doc.activeElement?.id).toBe("row-ada");
    await env.setItems([
      { id: "ada", name: "Ada" },
      { id: "grace", name: "Grace" },
    ]);
    await env.open("grace", false);
    await env.setItems([{ id: "ada", name: "Ada" }]);
    expect(doc.querySelector("[data-collection-item-peek]")).toBeNull();
    expect(doc.activeElement?.id).toBe("fallback");
    await env.unmount();
  });

  test("a refusing guard keeps the item open on × and on another item", async () => {
    let allow = false;
    const env = await setup(
      [
        { id: "ada", name: "Ada" },
        { id: "grace", name: "Grace" },
      ],
      { guard: () => allow },
    );
    await env.open("ada");
    await act(async () => {
      doc.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
    });
    await settle();
    expect(identity()).toBe("Ada");
    await env.open("grace");
    expect(identity()).toBe("Ada");
    allow = true;
    await act(async () => {
      doc.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
    });
    await settle();
    expect(doc.querySelector("[data-collection-item-peek]")).toBeNull();
    expect(doc.activeElement?.id).toBe("row-ada");
    await env.unmount();
  });
}
