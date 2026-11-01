import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CollectionDetailItemBinding } from "./detail-item-binding";
import type {
  CollectionDetailController,
  CollectionDetailSelection,
} from "./types";

interface Item {
  id: string;
  name: string;
}

if (process.env.SVODE_DETAIL_ITEM_BINDING_DOM !== "1") {
  test("detail item binding DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DETAIL_ITEM_BINDING_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><button id=fallback>Rows</button></body></html>",
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
  const selection: CollectionDetailSelection = {
    instanceKey: "people:root",
    presentationId: "all",
    itemId: "ada",
  };

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  /** A block the user expanded inside the detail. */
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

  async function setup() {
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { CollectionDetailPeekHost, useCollectionDetailController } =
      await import("./detail-peek");
    const { useCollectionDetailItemBinding } =
      await import("./detail-item-binding");

    let guardCalls = 0;
    const owner: {
      binding?: CollectionDetailItemBinding<Item>;
      controller?: CollectionDetailController;
      setItems?: (items: readonly Item[] | null) => void;
    } = {};

    function Owner({ initial }: { initial: readonly Item[] }) {
      // Null while the source loads or failed to refresh.
      const [items, setItems] = useState<readonly Item[] | null>(initial);
      const controller = useCollectionDetailController();
      const binding = useCollectionDetailItemBinding<Item>({
        controller,
        createContent: (item) => ({
          canClose: () => {
            guardCalls += 1;
            return true;
          },
          content: (
            <Expandable>
              <p data-row-content>{item.name}</p>
            </Expandable>
          ),
          description: `About ${item.name}`,
          headerActions: (
            <button type="button" data-owner-action>
              Share {item.name}
            </button>
          ),
          title: item.name,
        }),
        findItem: items
          ? (target) => items.find((item) => item.id === target.itemId)
          : null,
      });
      useEffect(() => {
        Object.assign(owner, { binding, controller, setItems });
      }, [binding, controller]);
      return null;
    }

    const container = doc.createElement("div");
    doc.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Owner
            initial={[
              { id: "ada", name: "Ada" },
              { id: "bob", name: "Bob" },
            ]}
          />
          <CollectionDetailPeekHost />
        </TooltipProvider>,
      );
    });

    const trigger = doc.createElement("button");
    async function activate(item: Item) {
      await act(async () => {
        await owner.binding!.activation(selection)!(item, {
          actions: (version) => (
            <button type="button" data-row-action>
              Act on {(version as Item).name}
            </button>
          ),
          fallbackFocus: () => doc.getElementById("fallback"),
          // The row of the table, which leaves it with the item.
          returnFocus: () => trigger,
          itemId: item.id,
        });
      });
      await settle();
    }

    async function change(items: readonly Item[] | null) {
      await act(async () => {
        owner.setItems!(items);
      });
      await settle();
    }

    async function open(item: Item) {
      await act(async () => {
        await owner.binding!.open(item, selection);
      });
      await settle();
    }

    return {
      activate,
      change,
      open,
      controller: () => owner.controller!,
      guardCalls: () => guardCalls,
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  const peek = () => doc.querySelector("[data-collection-detail-peek]");
  const content = () => doc.querySelector("[data-row-content]")?.textContent;

  test("the open detail follows its item and closes once the item is gone", async () => {
    const env = await setup();
    await env.activate({ id: "ada", name: "Ada" });
    expect(content()).toBe("Ada");
    expect(doc.querySelector("[data-row-action]")?.textContent).toBe(
      "Act on Ada",
    );
    // The owner's actions come first, the item's follow.
    const owned = doc.querySelector("[data-owner-action]")!;
    expect(owned.textContent).toBe("Share Ada");
    expect(
      Boolean(
        owned.compareDocumentPosition(doc.querySelector("[data-row-action]")!) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // The user expanded a block, scrolled and focused a control in the peek.
    const expand = [...doc.querySelectorAll("button")].find(
      (button) => button.textContent === "Expand",
    )!;
    await act(async () => {
      expand.click();
    });
    const viewport = doc.querySelector("[data-collection-detail-scroll]");
    expand.focus();
    expect(doc.activeElement).toBe(expand);

    // A new ready state shows the current version in place.
    await env.change([
      { id: "ada", name: "Ada Lovelace" },
      { id: "bob", name: "Bob" },
    ]);
    expect(content()).toBe("Ada Lovelace");
    expect(doc.querySelector('[data-slot="sheet-title"]')?.textContent).toBe(
      "Ada Lovelace",
    );
    expect(doc.querySelector("[data-row-action]")?.textContent).toBe(
      "Act on Ada Lovelace",
    );
    expect(
      doc.querySelector("[data-expandable]")?.getAttribute("data-expandable"),
    ).toBe("open");
    expect(doc.querySelector("[data-collection-detail-scroll]")).toBe(viewport);
    expect(doc.activeElement).toBe(expand);
    expect(env.guardCalls()).toBe(0);

    // Loading and a failed refresh leave the detail as it is.
    await env.change(null);
    expect(content()).toBe("Ada Lovelace");
    expect(peek()?.getAttribute("data-state")).toBe("open");

    // Another item changing or leaving does not touch the open detail.
    await env.change([{ id: "ada", name: "Ada Lovelace" }]);
    expect(content()).toBe("Ada Lovelace");
    expect(peek()?.getAttribute("data-state")).toBe("open");

    // The item left the set: the peek closes, focus falls back.
    await env.change([{ id: "bob", name: "Bob" }]);
    expect(peek()?.getAttribute("data-state") === "open").toBe(false);
    await settle();
    expect(doc.activeElement?.id).toBe("fallback");
    expect(env.guardCalls()).toBe(1);

    // The item coming back does not reopen the closed peek.
    await env.change([{ id: "ada", name: "Ada" }]);
    expect(peek()?.getAttribute("data-state") === "open").toBe(false);

    await env.unmount();
  });

  test("the detail leaves a peek that another detail took", async () => {
    const env = await setup();
    await env.activate({ id: "ada", name: "Ada" });

    // A file opened from the detail replaces it in the same peek.
    await act(async () => {
      await env.controller().open({
        content: <p data-file>guide.md</p>,
        description: "File",
        selection: { ...selection, instanceKey: "files:ada", itemId: "guide" },
        title: "guide.md",
      });
    });
    await settle();

    await env.change([{ id: "ada", name: "Ada Lovelace" }]);
    expect(doc.querySelector("[data-file]")?.textContent).toBe("guide.md");
    await env.change([]);
    expect(doc.querySelector("[data-file]")?.textContent).toBe("guide.md");
    expect(peek()?.getAttribute("data-state")).toBe("open");

    await act(async () => {
      await env.controller().close();
    });
    await settle();
    await env.unmount();
  });

  test("a detail opened outside activation follows the current state and keeps its item actions after a form", async () => {
    const env = await setup();
    await env.activate({ id: "ada", name: "Ada" });

    // A form of the same item takes the peek; the item changes meanwhile.
    await act(async () => {
      await env.controller().open({
        content: <p data-form>Editing Ada</p>,
        description: "Form",
        layout: "form",
        selection,
        title: "Edit Ada",
      });
    });
    await settle();
    await env.change([{ id: "ada", name: "Ada Lovelace" }]);
    expect(doc.querySelector("[data-form]")?.textContent).toBe("Editing Ada");

    // Cancel shows the item again from the version it was edited from: the
    // next render shows the current one with the item actions it had.
    await env.open({ id: "ada", name: "Ada" });
    expect(content()).toBe("Ada Lovelace");
    expect(doc.querySelector("[data-row-action]")?.textContent).toBe(
      "Act on Ada Lovelace",
    );

    // Opened after the item left the set, the detail closes.
    await env.change([]);
    expect(peek()?.getAttribute("data-state") === "open").toBe(false);
    await env.change([{ id: "bob", name: "Bob" }]);
    await env.open({ id: "ada", name: "Ada" });
    expect(peek()?.getAttribute("data-state") === "open").toBe(false);

    await env.unmount();
  });
}
