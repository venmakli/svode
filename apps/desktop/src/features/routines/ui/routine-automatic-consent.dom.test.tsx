import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { TooltipProvider } from "@/components/ui/tooltip";

import { RoutineAutomaticConsent } from "./routine-automatic-consent";

test("the full compact control toggles once from either the shell or switch", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const changes: boolean[] = [];
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <RoutineAutomaticConsent
            enabled={false}
            error={null}
            loading={false}
            ownerKind="project"
            pending={false}
            onChange={(enabled) => changes.push(enabled)}
            onRetry={() => undefined}
          />
        </TooltipProvider>,
      );
    });

    const shell = dom.window.document.querySelector<HTMLLabelElement>(
      "[data-routine-automatic-authority]",
    )!;
    const switchControl = dom.window.document.querySelector<HTMLButtonElement>(
      '[role="switch"]',
    )!;

    await act(async () => shell.click());
    expect(changes).toEqual([true]);

    changes.length = 0;
    await act(async () => switchControl.click());
    expect(changes).toEqual([true]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
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
