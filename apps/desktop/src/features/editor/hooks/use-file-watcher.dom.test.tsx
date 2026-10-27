import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  closeActiveContent,
  getActiveContentSelection,
} from "@/features/artifact";
import { openPage } from "@/features/page/navigation";
import type { Page, PageSourceConflict } from "@/features/page";
import { emit } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { useEditorStore } from "../model";
import type { DocumentSourceBaseline } from "../model/plate-document-cache";
import { createSourceSync } from "../model/source-sync";
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

test("a creation of the open document's path reconciles it like a change", async () => {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  mockNativeIpc(() => null, { shouldMockEvents: true });
  const path = "Tasks/README.md";
  const source = (body: string, version: string): Page => ({
    path,
    body,
    source_version: version,
    meta: { title: "Tasks", icon: null, created: "", updated: "", extra: {} },
  });
  const state = {
    baseline: { version: "v1", body: "Loaded\n" } as DocumentSourceBaseline,
    draft: false,
    disk: source("Loaded\n", "v1"),
    reads: 0,
    shown: "Loaded\n",
    conflict: null as PageSourceConflict | null,
  };
  const sync = createSourceSync({
    baseline: () => state.baseline,
    setBaseline: (_path, next) => {
      state.baseline = next;
    },
    hasDraft: () => state.draft,
    whenWritesSettled: async () => {},
    readSource: async () => {
      state.reads += 1;
      return state.disk;
    },
    loadSource: async (_path, page) => {
      state.shown = page.body;
      state.baseline = { version: page.source_version!, body: page.body };
    },
    adoptMetadata: () => {},
    writeDraft: async () => null,
    setAutoSavePaused: () => {},
    report: (conflict) => {
      state.conflict = conflict;
    },
    onResolved: () => {},
  });
  const ownNoncesRef = { current: new Set<string>(["own"]) };
  const reconcile = (changed: string) =>
    void sync.reconcile(changed, "external");
  function Harness() {
    useFileWatcher({
      spacePath: "/space",
      activeDocument: path,
      ownNoncesRef,
      onActiveDocumentChanged: reconcile,
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("app")!);
  const created = async (eventPath: string, writeNonce?: string) => {
    await act(async () => {
      await emit("file:created", {
        space: "/space",
        path: eventPath,
        writeNonce,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () => {
      root.render(<Harness />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Echo of an own write and another document's creation leave it alone.
    state.disk = source("Own\n", "v-own");
    await created(path, "own");
    await created("Tasks/Other.md");
    expect(state.reads).toBe(0);
    expect(
      useEditorStore.getState().hasAiModified("/space", "Tasks/Other.md"),
    ).toBe(false);

    state.disk = source("Replaced\n", "v2");
    await created(path);
    expect(state.shown).toBe("Replaced\n");
    expect(state.conflict).toBe(null);

    state.draft = true;
    state.disk = source("Replaced again\n", "v3");
    await created(path);
    expect(state.shown).toBe("Replaced\n");
    expect(state.conflict?.status).toBe("ready");
  } finally {
    sync.dispose();
    await act(async () => root.unmount());
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
