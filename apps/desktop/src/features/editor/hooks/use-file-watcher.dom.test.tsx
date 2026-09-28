import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  closeActiveContent,
  getActiveContentSelection,
} from "@/features/artifact";
import { openPage } from "@/features/page/navigation";
import { emit } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { useFileWatcher } from "./use-file-watcher";

test("a deleted document does not close the main content from inside its editor", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  mockNativeIpc(() => null, { shouldMockEvents: true });
  closeActiveContent();
  openPage("Tasks/README.md", "space");
  const selection = getActiveContentSelection().selection;
  const ownNoncesRef = { current: new Set<string>() };
  function Harness({ document }: { document: string }) {
    useFileWatcher({
      spacePath: "/space",
      activeDocument: document,
      ownNoncesRef,
      onActiveDocumentChanged: () => {},
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    for (const document of ["Tasks/Item2.md", "Tasks/README.md"]) {
      await act(async () => {
        root.render(<Harness document={document} />);
        await tick();
      });
      await act(async () => {
        await emit("file:deleted", { space: "/space", path: document });
        await tick();
      });
      expect(getActiveContentSelection().selection).toBe(selection);
    }
  } finally {
    await act(async () => root.unmount());
    closeActiveContent();
    clearNativeMocks();
    restore();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
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
