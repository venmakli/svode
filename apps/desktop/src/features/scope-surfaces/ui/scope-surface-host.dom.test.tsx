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
