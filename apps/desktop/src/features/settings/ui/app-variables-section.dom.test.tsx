import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { variableFixture, catalogFixture } from "../model/testing/variables";
import { AppVariablesSection } from "./app-variables-section";

test("global catalog edits a Secret without reading or replacing its value", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const mutations: Array<{ command: string; args: unknown }> = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "get_app_variables") {
        return catalogFixture(
          [
            variableFixture(
              {
                name: "SHARED_SECRET",
                kind: "secret",
                hasValue: true,
                usedIn: [
                  { ownerDirectory: "/repo/admin", referenceName: "OTHER" },
                  {
                    ownerDirectory: "/repo/space",
                    referenceName: "S3 Secret Key",
                  },
                ],
              },
              { scope: "library" },
            ),
          ],
          { scope: "library" },
        );
      }
      if (
        command === "upsert_app_variable" ||
        command === "set_app_variable_binding"
      ) {
        mutations.push({ command, args });
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<AppVariablesSection />);
      await nextTurn();
      await nextTurn();
    });
    expect(dom.window.document.body.textContent?.includes("••••••••")).toBe(
      true,
    );
    expect(dom.window.document.body.textContent?.includes("top-secret")).toBe(
      false,
    );
    expect(
      dom.window.document.body.textContent?.includes("admin · OTHER"),
    ).toBe(true);

    expect(
      dom.window.document.body.textContent?.includes(
        "/repo/space · S3 Secret Key",
      ),
    ).toBe(true);

    const createButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (button) => button.getAttribute("aria-label") === "Edit SHARED_SECRET",
    );
    await act(async () => {
      createButton?.click();
      await nextTurn();
    });
    const saveButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Save");
    await act(async () => {
      saveButton?.click();
      await nextTurn();
      await nextTurn();
      await nextTurn();
    });

    expect(mutations.map((mutation) => mutation.command)).toEqual([
      "upsert_app_variable",
    ]);
    expect(mutations[0]?.args).toEqual({
      input: {
        source: { owner: { scope: "library" }, name: "SHARED_SECRET" },
        mode: "local",
        kind: "secret",
        identity: "id-SHARED_SECRET",
        revision: "r1",
      },
    });
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
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
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
