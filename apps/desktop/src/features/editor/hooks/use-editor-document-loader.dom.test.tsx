import { expect, test } from "bun:test";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Descendant } from "platejs";
import { createPlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Page } from "@/features/page";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
import { useEditorDocumentLoader } from "./use-editor-document-loader";

const SPACE = "/space";

function page(path: string, body: string, version: string): Page {
  return {
    path,
    body,
    source_version: version,
    meta: { title: "Notes", icon: null, created: "", updated: "", extra: {} },
  };
}

function textOf(nodes: Descendant[]): string {
  return nodes
    .map((node) =>
      "text" in node
        ? String(node.text)
        : textOf((node as { children: Descendant[] }).children),
    )
    .join("");
}

async function harness(disk: Map<string, Page>) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  dom.window.requestAnimationFrame = (callback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0);
  const reads: string[] = [];
  mockNativeIpc((command, args) => {
    if (command !== "read_page") return null;
    const path = String((args as { path: string }).path);
    reads.push(path);
    const source = disk.get(path);
    if (!source) throw new Error(`File not found: ${path}`);
    return structuredClone(source);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);
  let editor = createPlateEditor({ plugins: [MarkdownPlugin] });
  const loading: boolean[] = [];
  const noop = () => {};
  const loadEditorValue = (value: Descendant[]) =>
    loadProgrammaticEditorValue(editor, value);
  const shown = { key: null as string | null };

  function Loader({
    path,
    initialPage,
  }: {
    path: string;
    initialPage: Page | null;
  }) {
    const adoptedDocumentKeyRef = useRef<string | null>(null);
    const currentCacheKeyRef = useRef<string | null>(null);
    const currentPathRef = useRef<string | null>(null);
    const isLoadingRef = useRef(false);
    const { documentLoading, loadedDocumentKey } = useEditorDocumentLoader({
      bodyOnly: true,
      bodyOnlyMeta: initialPage?.meta ?? null,
      adoptedDocumentKeyRef,
      cancelDebounce: noop,
      clearUnsaved: noop,
      currentCacheKeyRef,
      currentDocument: path,
      documentPathHandoff: null,
      currentDocumentSpaceId: "space",
      currentPathRef,
      editor,
      initialPage,
      initialPageSpacePath: initialPage ? SPACE : null,
      isLoadingRef,
      loadEditorValue: loadEditorValue,
      setBrokenLinks: noop,
      spacePath: SPACE,
    });
    useEffect(() => {
      loading.push(documentLoading);
      shown.key = loadedDocumentKey;
    }, [documentLoading, loadedDocumentKey]);
    return null;
  }

  // Each turn runs in its own act scope so the loaded key renders.
  const loaded = async (path: string) => {
    for (let turn = 0; turn < 50 && shown.key !== `${SPACE}\0${path}`; turn++)
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  };

  return {
    reads,
    loading,
    /** Mounts a new editor for the document, as opening its surface does. */
    open: async (path: string, initialPage: Page | null) => {
      editor = createPlateEditor({ plugins: [MarkdownPlugin] });
      loading.length = 0;
      reads.length = 0;
      await act(async () => {
        root.render(<Loader path={path} initialPage={initialPage} />);
      });
      await loaded(path);
      return textOf(editor.children as Descendant[]);
    },
    /** Leaves the surface: the editor is unmounted and gets no file events. */
    leave: async () => {
      await act(async () => root.render(null));
      shown.key = null;
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restore();
      dom.window.close();
    },
  };
}

test("a reopened document shows the file body after a change while its editor was closed", async () => {
  const path = "notes/changed-closed.md";
  const disk = new Map([[path, page(path, "First body", "v1")]]);
  const view = await harness(disk);
  try {
    expect(await view.open(path, disk.get(path)!)).toBe("First body");
    expect(view.reads).toEqual([]);
    await view.leave();

    disk.set(path, page(path, "Agent body", "v2"));
    expect(await view.open(path, disk.get(path)!)).toBe("Agent body");
    expect(view.reads).toEqual([path]);
    expect(view.loading.some(Boolean)).toBe(false);
  } finally {
    await view.cleanup();
  }
});

test("an unchanged document reopens from the cache without a read or skeleton", async () => {
  const path = "notes/unchanged.md";
  const disk = new Map([[path, page(path, "Kept body", "v1")]]);
  const view = await harness(disk);
  try {
    expect(await view.open(path, disk.get(path)!)).toBe("Kept body");
    expect(view.loading.some(Boolean)).toBe(true);
    await view.leave();

    expect(await view.open(path, disk.get(path)!)).toBe("Kept body");
    expect(view.reads).toEqual([]);
    expect(view.loading.some(Boolean)).toBe(false);
  } finally {
    await view.cleanup();
  }
});

test("a provided Page older than the cached body is checked against the file", async () => {
  const path = "notes/provided-older.md";
  const first = page(path, "First body", "v1");
  const disk = new Map([[path, first]]);
  const view = await harness(disk);
  try {
    expect(await view.open(path, first)).toBe("First body");
    await view.leave();
    disk.set(path, page(path, "Second body", "v2"));
    expect(await view.open(path, disk.get(path)!)).toBe("Second body");
    await view.leave();

    // The Page detail still holds its first read while the editor remounts.
    expect(await view.open(path, first)).toBe("Second body");
    expect(view.reads).toEqual([path]);
  } finally {
    await view.cleanup();
  }
});

test("without a provided Page the reopened document compares the read version", async () => {
  const path = "notes/read-only-source.md";
  const disk = new Map([[path, page(path, "First body", "v1")]]);
  const view = await harness(disk);
  try {
    expect(await view.open(path, null)).toBe("First body");
    await view.leave();
    expect(await view.open(path, null)).toBe("First body");
    expect(view.reads).toEqual([path]);
    await view.leave();

    disk.set(path, page(path, "Script body", "v2"));
    expect(await view.open(path, null)).toBe("Script body");
    expect(view.reads).toEqual([path]);
  } finally {
    await view.cleanup();
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
