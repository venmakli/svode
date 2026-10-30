import { expect, test } from "bun:test";
import { act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Descendant } from "platejs";
import { createPlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import type { Page } from "@/features/page";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { ConflictElement } from "../conflict/parse-conflicts";
import { loadProgrammaticEditorValue } from "../model/programmatic-editor-load";
import { BrokenLinksPlugin } from "../plate/broken-links-plugin";
import { useEditorDocumentLoader } from "./use-editor-document-loader";
import { useEditorLinkValidation } from "./use-editor-link-validation";

const SPACE = "/space";
const BROKEN = "Nowhere.md";
const WORKING = "Here.md";

function keyOf(path: string) {
  return `${SPACE}\0${path}`;
}

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

async function harness(disk: Map<string, Page>, markerSize = 7) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", {
    url: "http://localhost/",
  });
  const restore = installDomGlobals(dom);
  dom.window.requestAnimationFrame = (callback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0);
  const reads: string[] = [];
  const validations: string[] = [];
  const heldReads = new Map<string, () => void>();
  const markerSizeReads: string[] = [];
  mockNativeIpc(async (command, args) => {
    const path = String((args as { path: string }).path);
    if (command === "git_conflict_marker_size") {
      markerSizeReads.push(path);
      return markerSize;
    }
    if (command === "validate_links") {
      validations.push(path);
      return [
        { url: BROKEN, exists: false },
        { url: WORKING, exists: true },
      ];
    }
    if (command !== "read_page") return null;
    reads.push(path);
    if (heldReads.has(path)) {
      await new Promise<void>((resolve) => heldReads.set(path, resolve));
    }
    const source = disk.get(path);
    if (!source) throw new Error(`File not found: ${path}`);
    return structuredClone(source);
  });
  const root = createRoot(dom.window.document.getElementById("app")!);
  const newEditor = () =>
    createPlateEditor({ plugins: [MarkdownPlugin, BrokenLinksPlugin] });
  let editor = newEditor();
  const loading: boolean[] = [];
  const noop = () => {};
  const loadEditorValue = (value: Descendant[]) =>
    loadProgrammaticEditorValue(editor, value);
  const shown = { key: null as string | null };
  const keys: (string | null)[] = [];
  // The marks of the editor of the open surface.
  const marks = {
    get broken() {
      return editor.getOption(BrokenLinksPlugin, "brokenLinks");
    },
  };

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
      spacePath: SPACE,
    });
    // The document session validates links for the key of the current document.
    useEditorLinkValidation({
      editor,
      loadedDocumentKey:
        loadedDocumentKey === keyOf(path) ? loadedDocumentKey : null,
      currentDocument: path,
      spacePath: SPACE,
      projectPath: null,
    });
    useEffect(() => {
      loading.push(documentLoading);
      shown.key = loadedDocumentKey;
      keys.push(loadedDocumentKey);
    }, [documentLoading, loadedDocumentKey]);
    return null;
  }

  // Each turn runs in its own act scope so the loaded key and marks render.
  const settle = async (done: () => boolean) => {
    for (let turn = 0; turn < 50 && !done(); turn++)
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const render = async (path: string, initialPage: Page | null) => {
    loading.length = 0;
    reads.length = 0;
    validations.length = 0;
    keys.length = 0;
    await act(async () => {
      root.render(<Loader path={path} initialPage={initialPage} />);
    });
  };
  const loaded = async (path: string) => {
    await settle(() => shown.key === keyOf(path) && validations.includes(path));
    await settle(() => marks.broken.size > 0);
    return textOf(editor.children as Descendant[]);
  };

  return {
    reads,
    markerSizeReads,
    conflicts: () =>
      (editor.children as Descendant[])
        .filter((node) => (node as { type?: string }).type === "conflict")
        .map((node) => {
          const { ours, theirs } = node as unknown as ConflictElement;
          return { ours, theirs };
        }),
    loading,
    validations,
    keys,
    marks,
    key: () => shown.key,
    settle,
    /** Holds reads of the document until the returned release is called. */
    holdRead: (path: string) => {
      heldReads.set(path, noop);
      return () => {
        const release = heldReads.get(path);
        heldReads.delete(path);
        release?.();
      };
    },
    /** Mounts a new editor for the document, as opening its surface does. */
    open: async (path: string, initialPage: Page | null) => {
      editor = newEditor();
      await render(path, initialPage);
      return loaded(path);
    },
    /** Starts loading in a new editor without waiting for the load. */
    start: async (path: string, initialPage: Page | null) => {
      editor = newEditor();
      await render(path, initialPage);
    },
    /** Runs the load again in the open editor, as a new provided Page does. */
    reload: async (path: string, initialPage: Page | null) => {
      await render(path, initialPage);
      return loaded(path);
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

type View = Awaited<ReturnType<typeof harness>>;

/** The load ended with the document key and one link validation of it. */
function expectValidated(view: View, path: string) {
  expect(view.key()).toBe(keyOf(path));
  expect(view.validations).toEqual([path]);
  expect([...view.marks.broken]).toEqual([BROKEN]);
}

test("a reopened document shows the file body after a change while its editor was closed", async () => {
  const path = "notes/changed-closed.md";
  const disk = new Map([[path, page(path, "First body", "v1")]]);
  const view = await harness(disk);
  try {
    // initial-page
    expect(await view.open(path, disk.get(path)!)).toBe("First body");
    expect(view.reads).toEqual([]);
    expectValidated(view, path);
    await view.leave();

    // read-page: the cache check reads a newer source version
    disk.set(path, page(path, "Agent body", "v2"));
    expect(await view.open(path, disk.get(path)!)).toBe("Agent body");
    expect(view.reads).toEqual([path]);
    expect(view.loading.some(Boolean)).toBe(false);
    expectValidated(view, path);
  } finally {
    await view.cleanup();
  }
});

test("an unchanged document reopens from the cache without a read or skeleton", async () => {
  const path = "notes/unchanged.md";
  const other = "notes/other.md";
  const disk = new Map([
    [path, page(path, `[Gone](${BROKEN}) and [Kept](${WORKING})`, "v1")],
    [other, page(other, "Other body", "v1")],
  ]);
  const view = await harness(disk);
  try {
    expect(await view.open(path, disk.get(path)!)).toBe("Gone and Kept");
    expect(view.loading.some(Boolean)).toBe(true);
    expectValidated(view, path);
    await view.leave();
    await view.open(other, disk.get(other)!);
    await view.leave();

    // cache: the provided Page proves the cached version without a read
    expect(await view.open(path, disk.get(path)!)).toBe("Gone and Kept");
    expect(view.reads).toEqual([]);
    expect(view.loading.some(Boolean)).toBe(false);
    expectValidated(view, path);
  } finally {
    await view.cleanup();
  }
});

test("a load that completes from the cache again in the open editor validates links again", async () => {
  const path = "notes/reloaded.md";
  const disk = new Map([[path, page(path, "Kept body", "v1")]]);
  const view = await harness(disk);
  try {
    await view.open(path, disk.get(path)!);
    expectValidated(view, path);

    // A new provided Page in the cached version reruns the load from the cache.
    expect(await view.reload(path, page(path, "Kept body, longer", "v1"))).toBe(
      "Kept body",
    );
    expect(view.reads).toEqual([]);
    expect(view.keys).toEqual([null, keyOf(path)]);
    expectValidated(view, path);
  } finally {
    await view.cleanup();
  }
});

test("a load replaced by another document does not set its key", async () => {
  const stale = "notes/stale.md";
  const current = "notes/current.md";
  const disk = new Map([
    [stale, page(stale, "Stale body", "v1")],
    [current, page(current, "Current body", "v1")],
  ]);
  const view = await harness(disk);
  try {
    const release = view.holdRead(stale);
    await view.start(stale, null);
    await view.settle(() => view.reads.includes(stale));
    expect(await view.open(current, null)).toBe("Current body");
    release();
    await view.settle(() => false);

    expect(view.keys.includes(keyOf(stale))).toBe(false);
    expectValidated(view, current);
  } finally {
    await view.cleanup();
  }
});

test("a failed load leaves the key empty and does not validate links", async () => {
  const path = "notes/missing.md";
  const view = await harness(new Map());
  try {
    await view.start(path, null);
    await view.settle(() => view.reads.includes(path));
    await view.settle(() => false);

    expect(view.key()).toBeNull();
    expect(view.validations).toEqual([]);
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

    // cache-meta-read: the Page detail still holds its first read while the
    // editor remounts.
    expect(await view.open(path, first)).toBe("Second body");
    expect(view.reads).toEqual([path]);
    expectValidated(view, path);
  } finally {
    await view.cleanup();
  }
});

test("without a provided Page the reopened document compares the read version", async () => {
  const path = "notes/read-only-source.md";
  const disk = new Map([[path, page(path, "First body", "v1")]]);
  const view = await harness(disk);
  try {
    // read-page
    expect(await view.open(path, null)).toBe("First body");
    expectValidated(view, path);
    await view.leave();
    // cache-meta-read
    expect(await view.open(path, null)).toBe("First body");
    expect(view.reads).toEqual([path]);
    expectValidated(view, path);
    await view.leave();

    disk.set(path, page(path, "Script body", "v2"));
    expect(await view.open(path, null)).toBe("Script body");
    expect(view.reads).toEqual([path]);
    expectValidated(view, path);
  } finally {
    await view.cleanup();
  }
});

test("every load path parses conflict blocks with the marker size of the path", async () => {
  const path = "notes/conflicted.md";
  const other = "notes/other-conflicted.md";
  const links = `[Gone](${BROKEN}) and [Kept](${WORKING})`;
  const conflicted = (ours: string) =>
    [
      links,
      "",
      "<<<<<<<<<< HEAD",
      ours,
      "=======",
      "==========",
      "theirs",
      ">>>>>>>>>> other",
      "",
    ].join("\r\n");
  const first = page(path, conflicted("first"), "v1");
  const plain = "notes/plain.md";
  const disk = new Map([
    [path, first],
    [other, page(other, conflicted("other"), "v1")],
    [plain, page(plain, `${links}\n\n> quote\n`, "v1")],
  ]);
  const view = await harness(disk, 10);
  try {
    // initial-page
    await view.open(path, first);
    expect(view.conflicts()).toEqual([
      { ours: "first\r\n=======", theirs: "theirs" },
    ]);
    expect(view.markerSizeReads).toEqual([path]);
    expectValidated(view, path);
    await view.leave();

    // cache-meta-read of a newer source version
    disk.set(path, page(path, conflicted("second"), "v2"));
    await view.open(path, null);
    expect(view.reads).toEqual([path]);
    expect(view.conflicts()).toEqual([
      { ours: "second\r\n=======", theirs: "theirs" },
    ]);
    expect(view.markerSizeReads).toEqual([path, path]);
    await view.leave();

    // read-page
    await view.open(other, null);
    expect(view.conflicts()).toEqual([
      { ours: "other\r\n=======", theirs: "theirs" },
    ]);
    expect(view.markerSizeReads).toEqual([path, path, other]);
    await view.leave();

    // Without a line opening a block Git is not asked.
    await view.open(plain, null);
    expect(view.conflicts()).toEqual([]);
    expect(view.markerSizeReads).toEqual([path, path, other]);
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
