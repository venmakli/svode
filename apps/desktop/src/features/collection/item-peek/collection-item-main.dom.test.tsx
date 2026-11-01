import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  ScopeMainItem,
  ScopeMainItemTopBar,
} from "@/features/scope-surfaces";

interface Item {
  id: string;
  name: string;
}

if (process.env.SVODE_COLLECTION_ITEM_MAIN_DOM !== "1") {
  test("collection item main DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ITEM_MAIN_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const doc = dom.window.document;
  const { CollectionItemMain } = await import("./collection-item-main");

  async function setup(guarded: boolean) {
    const calls = {
      gone: 0,
      guards: [] as Array<() => Promise<boolean>>,
      topBars: [] as ScopeMainItemTopBar[],
    };
    const main: ScopeMainItem = {
      item: { surfaceId: "routines", itemId: "ada" },
      renderTopBar: (parts) => {
        calls.topBars.push(parts);
        return <div data-top-bar>{parts.identity.name}</div>;
      },
      registerNavigationGuard: (guard) => {
        calls.guards.push(guard);
        return () => {
          calls.guards.splice(calls.guards.indexOf(guard), 1);
        };
      },
      onGone: () => {
        calls.gone += 1;
      },
    };
    const owner: { setItems?: (items: readonly Item[] | null) => void } = {};
    function Owner() {
      const [items, setItems] = useState<readonly Item[] | null>(null);
      useEffect(() => {
        owner.setItems = setItems;
      }, []);
      return (
        <CollectionItemMain
          main={main}
          target="ada"
          find={(id: string) =>
            items ? items.find((item) => item.id === id) : null
          }
          render={(item: Item) => ({
            ...(guarded ? { canClose: async () => false } : {}),
            content: <p data-item-content>{item.name}</p>,
            header: { icon: <span>☺</span>, title: item.name },
            identity: { icon: <span>☺</span>, name: item.name },
            menu: <button type="button">Actions</button>,
            tools: <button type="button">Run</button>,
          })}
        />
      );
    }
    const root = createRoot(doc.body.appendChild(doc.createElement("div")));
    await act(async () => root.render(<Owner />));
    return {
      calls,
      async setItems(items: readonly Item[] | null) {
        await act(async () => owner.setItems!(items));
      },
      async unmount() {
        await act(async () => root.unmount());
      },
    };
  }

  test("the screen of the item: its top bar parts, then the content header and content", async () => {
    const env = await setup(false);
    // Until the source is read, the screen waits.
    expect(doc.querySelector("[data-item-content]")).toBeNull();
    expect(doc.querySelector("[aria-busy]") === null).toBe(false);
    await env.setItems([{ id: "ada", name: "Ada" }]);
    const parts = env.calls.topBars.at(-1)!;
    expect(parts.identity.name).toBe("Ada");
    expect(parts.menu === undefined).toBe(false);
    expect(parts.tools === undefined).toBe(false);
    expect(doc.querySelector("[data-top-bar]")?.textContent).toBe("Ada");
    expect(doc.querySelector("[data-object-content-header]")?.textContent).toBe(
      "☺Ada",
    );
    expect(env.calls.guards.length).toBe(0);
    await env.unmount();
  });

  test("a new version draws in place, a source that is not ready keeps it, a gone item closes once", async () => {
    const env = await setup(true);
    await env.setItems([{ id: "ada", name: "Ada" }]);
    const content = doc.querySelector("[data-item-content]");
    expect(env.calls.guards.length).toBe(1);
    expect(await env.calls.guards[0]()).toBe(false);
    await env.setItems([{ id: "ada", name: "Ada Lovelace" }]);
    expect(doc.querySelector("[data-item-content]")).toBe(content);
    expect(content?.textContent).toBe("Ada Lovelace");
    await env.setItems(null);
    expect(content?.textContent).toBe("Ada Lovelace");
    expect(env.calls.gone).toBe(0);
    await env.setItems([{ id: "grace", name: "Grace" }]);
    expect(env.calls.gone).toBe(1);
    await env.unmount();
    expect(env.calls.guards.length).toBe(0);
  });
}
