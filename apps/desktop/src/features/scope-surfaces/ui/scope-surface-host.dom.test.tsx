import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createCollectionDirectoryOwner } from "../model/owners";
import { useScopeSurfaceStore } from "../model/surface-store";
import type { ScopeSurfaceContribution } from "../model/types";
import { ScopeSurfaceHost } from "./scope-surface-host";

const contribution: ScopeSurfaceContribution = {
  id: "collection",
  label: "Collection",
  order: 0,
  presentations: ["full"],
  appliesTo: () => true,
  icon: () => null,
  render: ({ owner }) => (
    <input data-testid="surface-focus" value={owner.ownerPath} readOnly />
  ),
};

test("owner retarget preserves the mounted scope surface and focus", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const previousOwner = owner("tasks");
  const nextOwner = owner("Задачи");
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: {
      [previousOwner.ownerKey]: "collection" as const,
    },
    openRequestKeyByOwnerKey: { [previousOwner.ownerKey]: 7 },
  });

  try {
    await act(async () => {
      root.render(
        <ScopeSurfaceHost
          owner={previousOwner}
          presentation="full"
          contributions={[contribution]}
          header={null}
          openRequestKey={7}
          sessionKey={7}
        />,
      );
    });
    const focused = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="surface-focus"]',
    )!;
    focused.focus();

    await act(async () => {
      root.render(
        <ScopeSurfaceHost
          owner={nextOwner}
          presentation="full"
          contributions={[contribution]}
          header={null}
          openRequestKey={7}
          previousOwnerKey={previousOwner.ownerKey}
          sessionKey={7}
        />,
      );
    });

    const retargeted = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="surface-focus"]',
    )!;
    expect(retargeted).toBe(focused);
    expect(dom.window.document.activeElement).toBe(focused);
    expect(retargeted.value).toBe("Задачи");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test("owner surface round trip preserves the mounted Readme session", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById("app")!);
  const targetOwner = owner("tasks");
  const contributions: ScopeSurfaceContribution[] = [
    {
      ...contribution,
      id: "readme",
      label: "Readme",
      render: () => <input data-testid="readme-session" defaultValue="draft" />,
    },
    {
      ...contribution,
      id: "collection",
      label: "Collection",
      render: () => <div data-testid="collection-session">Collection</div>,
    },
  ];
  useScopeSurfaceStore.setState({
    surfaceByOwnerKey: { [targetOwner.ownerKey]: "readme" as const },
    openRequestKeyByOwnerKey: {},
  });

  try {
    await act(async () => {
      root.render(
        <ScopeSurfaceHost
          owner={targetOwner}
          presentation="full"
          contributions={contributions}
          header={null}
          sessionKey="session"
        />,
      );
    });
    const readme = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="readme-session"]',
    )!;
    readme.value = "pending draft";
    readme.focus();

    await act(async () => {
      activateTab(dom, "Collection");
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    expect(
      Boolean(
        dom.window.document.querySelector('[data-testid="collection-session"]'),
      ),
    ).toBe(true);
    expect(
      dom.window.document.querySelector('[data-testid="readme-session"]'),
    ).toBe(readme);

    await act(async () => {
      activateTab(dom, "Readme");
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    const restored = dom.window.document.querySelector<HTMLInputElement>(
      '[data-testid="readme-session"]',
    )!;
    expect(restored).toBe(readme);
    expect(restored.value).toBe("pending draft");
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function findTab(dom: JSDOM, label: string) {
  return Array.from(
    dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((tab) => tab.textContent === label)!;
}

function activateTab(dom: JSDOM, label: string) {
  findTab(dom, label).dispatchEvent(
    new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
    }),
  );
}

function owner(ownerPath: string) {
  return createCollectionDirectoryOwner({
    spaceId: "root",
    projectPath: "/repo",
    spacePath: "/repo",
    ownerPath,
    status: "ready",
    hasSchema: true,
  });
}

function installDomGlobals(dom: JSDOM) {
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.window.Node,
    document: dom.window.document,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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
