import { expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { toast } from "sonner";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a sidebar deletion of a folder closes its open Page without a message", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  const shown: unknown[] = [];
  const saved = { error: toast.error, warning: toast.warning };
  toast.error = ((message: unknown) => shown.push(message)) as never;
  toast.warning = ((message: unknown) => shown.push(message)) as never;
  const spacePath = `/sidebar-delete-${Math.random()}`;
  let exists = true;
  const { emit } = await import("@/platform/native/events");
  mockNativeIpc(
    async (command, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      if (command === "read_page") {
        if (!exists) throw `File not found: ${String(input.path)}`;
        return {
          path: input.path,
          body: "",
          meta: { title: "Item", icon: null, created: "", updated: "" },
        };
      }
      if (command === "delete_content") {
        exists = false;
        // The watcher reports the file gone before the command returns.
        await emit("file:deleted", { space: spacePath, path: "Notes/Item.md" });
        return null;
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  const { createRoot } = await import("react-dom/client");
  const { deleteTreeItem } = await import("./content-tree-actions");
  const { PageDetailProvider } = await import("@/features/page/scope-surface");
  const root = createRoot(dom.window.document.getElementById("app")!);
  let gone = 0;
  try {
    await act(async () => {
      root.render(
        <PageDetailProvider
          spacePath={spacePath}
          spaceId="root"
          readmePath="Notes/Item.md"
          ownerPath="Notes/Item.md"
          target="page"
          onOpenPath={() => {}}
          onPageGone={() => (gone += 1)}
        >
          {null}
        </PageDetailProvider>,
      );
      await turn();
      await turn();
    });
    await act(async () => {
      await deleteTreeItem({ spacePath, path: "Notes", projectPath: null });
      await turn();
      await turn();
    });
    expect(gone).toBe(1);
    expect(shown).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(toast, saved);
    clearNativeMocks();
    restore();
    dom.window.close();
  }
});

test("a sidebar deletion of an open directory Page closes it without a message though the watcher reports nothing", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  const shown: unknown[] = [];
  const saved = { error: toast.error, warning: toast.warning };
  toast.error = ((message: unknown) => shown.push(message)) as never;
  toast.warning = ((message: unknown) => shown.push(message)) as never;
  const spacePath = `/sidebar-delete-directory-${Math.random()}`;
  let exists = true;
  mockNativeIpc(
    async (command, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      if (command === "read_page") {
        if (!exists) throw `File not found: ${String(input.path)}`;
        return {
          path: input.path,
          body: "",
          meta: { title: "Kit", icon: null, created: "", updated: "" },
        };
      }
      if (command === "delete_content") {
        // Svode moves the directory away before removing it: the watcher
        // reports no event for it.
        exists = false;
        return null;
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  const { createRoot } = await import("react-dom/client");
  const { deleteTreeItem } = await import("./content-tree-actions");
  const { PageDetailProvider } = await import("@/features/page/scope-surface");
  const root = createRoot(dom.window.document.getElementById("app")!);
  let gone = 0;
  try {
    await act(async () => {
      root.render(
        <PageDetailProvider
          spacePath={spacePath}
          spaceId="root"
          readmePath="kit/README.md"
          ownerPath="kit"
          target="page"
          onOpenPath={() => {}}
          onPageGone={() => (gone += 1)}
        >
          {null}
        </PageDetailProvider>,
      );
      await turn();
      await turn();
    });
    await act(async () => {
      await deleteTreeItem({
        spacePath,
        path: "kit/README.md",
        projectPath: null,
      });
      await turn();
      await turn();
    });
    expect(gone).toBe(1);
    expect(shown).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(toast, saved);
    clearNativeMocks();
    restore();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    document: dom.window.document,
    window: dom.window,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
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
