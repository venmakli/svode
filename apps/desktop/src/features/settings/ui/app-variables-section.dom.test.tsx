import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { AppVariablesSection } from "./app-variables-section";

test("renders redacted Secrets and creates then binds a missing App reference", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  const restoreGlobals = installDomGlobals(dom);
  const mutations: Array<{ command: string; args: unknown }> = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "get_app_variables") {
        return {
          entries: [
            {
              name: "SHARED_SECRET",
              kind: "secret",
              hasValue: true,
              usedIn: [
                { ownerDirectory: "/repo/admin", referenceName: "OTHER" },
              ],
            },
          ],
          context: [
            {
              referenceName: "API_TOKEN",
              entryName: "API_TOKEN",
              resolved: false,
            },
          ],
        };
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
      root.render(
        <AppVariablesSection
          context={{
            projectPath: "/repo",
            spaceId: null,
            ownerPath: "admin",
          }}
        />,
      );
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

    const createButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Create API_TOKEN"));
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
      "set_app_variable_binding",
    ]);
    expect(mutations[0]?.args).toEqual({
      input: { name: "API_TOKEN", kind: "variable", value: "" },
    });
    expect(mutations[1]?.args).toEqual({
      input: {
        context: { projectPath: "/repo", spaceId: null, ownerPath: "admin" },
        referenceName: "API_TOKEN",
        entryName: "API_TOKEN",
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
