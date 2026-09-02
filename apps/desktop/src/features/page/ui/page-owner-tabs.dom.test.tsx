import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { PageOwnerTabs } from "./page-owner-tabs";

test("Page owner tabs gate deactivation and mount only the active scroll surface", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const lifecycle: string[] = [];
  let allowChange = false;

  function Surface({ id }: { id: "page" | "attachments" }) {
    useEffect(() => {
      lifecycle.push(`mount:${id}`);
      return () => {
        lifecycle.push(`unmount:${id}`);
      };
    }, [id]);
    return <div data-surface={id}>{id}</div>;
  }

  try {
    await act(async () => {
      root.render(
        <PageOwnerTabs
          page={<Surface id="page" />}
          attachments={<Surface id="attachments" />}
          prepareForPageDeactivation={async () => allowChange}
        />,
      );
    });
    expect(activeSurface(dom)).toBe("page");
    expect(lifecycle).toEqual(["mount:page"]);

    await activateTab(dom, 1);
    expect(activeSurface(dom)).toBe("page");
    expect(lifecycle).toEqual(["mount:page"]);

    allowChange = true;
    await activateTab(dom, 1);
    expect(activeSurface(dom)).toBe("attachments");
    expect(
      Array.from(dom.window.document.querySelectorAll("[data-surface]")).map(
        (node) => node.getAttribute("data-surface"),
      ),
    ).toEqual(["attachments"]);
    expect(lifecycle).toEqual([
      "mount:page",
      "unmount:page",
      "mount:attachments",
    ]);

    await activateTab(dom, 0);
    expect(activeSurface(dom)).toBe("page");
    expect(lifecycle).toEqual([
      "mount:page",
      "unmount:page",
      "mount:attachments",
      "unmount:attachments",
      "mount:page",
    ]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function activeSurface(dom: JSDOM) {
  return dom.window.document
    .querySelector("[data-page-owner-surface]")
    ?.getAttribute("data-page-owner-surface");
}

async function activateTab(dom: JSDOM, index: number) {
  const tabs =
    dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => {
    tabs[index]!.dispatchEvent(
      new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
