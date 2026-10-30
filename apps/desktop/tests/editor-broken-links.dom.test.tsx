import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Broken link marks belong to their editor (DF-245): a load, validation or
// unmount of one open editor never changes the marks of another, and a field
// that does not validate its links marks none.
if (process.env.SVODE_EDITOR_BROKEN_LINKS_DOM !== "1") {
  test("editor broken links DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_EDITOR_BROKEN_LINKS_DOM: "1" },
      encoding: "utf8",
    });
    expect(child.status, child.stdout + child.stderr).toBe(0);
  }, 60000);
} else {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost/",
    },
  );
  const domGlobals = dom.window as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!/^[A-Z]/.test(key) || key in globalThis) continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: domGlobals[key],
    });
  }
  for (const key of [
    "window",
    "document",
    "navigator",
    "Event",
    "CustomEvent",
    "EventTarget",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "FocusEvent",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const key of ["ResizeObserver", "IntersectionObserver"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: NoopObserver,
    });
    Object.defineProperty(dom.window, key, {
      configurable: true,
      value: NoopObserver,
    });
  }
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    media: "",
    onchange: null,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { mockNativeIpc } = await import("../src/platform/native/testing");
  const { ControlledMarkdownEditor } =
    await import("../src/features/editor/plate/controlled-markdown-editor");
  const { PlateDocumentEditor } =
    await import("../src/features/editor/plate/plate-editor");
  type Page = import("../src/features/page").Page;

  const A = "a.md";
  const B = "b.md";
  const page = (path: string, body: string, version = "v1"): Page => ({
    path,
    body,
    source_version: version,
    meta: { title: path, icon: null, created: "", updated: "", extra: {} },
  });
  const pages: Record<string, Page> = {
    [A]: page(A, "[Gone A](Gone%20A.md) and [Gone B](Gone%20B.md)\n"),
    [B]: page(B, "[Gone B](Gone%20B.md) and [Gone A](Gone%20A.md)\n"),
  };
  // `validate_links` of each document: the decoded paths as written.
  const results: Record<string, { url: string; exists: boolean }[]> = {
    [A]: [
      { url: "Gone A.md", exists: false },
      { url: "Gone B.md", exists: true },
    ],
    [B]: [
      { url: "Gone B.md", exists: false },
      { url: "Gone A.md", exists: true },
    ],
  };
  const validations: string[] = [];
  const held = new Map<string, () => void>();
  mockNativeIpc(async (command, args) => {
    const path = (args as { path?: string }).path ?? "";
    if (command === "read_page") return structuredClone(pages[path]);
    if (command === "validate_links") {
      validations.push(path);
      if (held.has(path)) {
        await new Promise<void>((resolve) => held.set(path, resolve));
      }
      return results[path];
    }
    return null;
  });

  const settle = async (done: () => boolean = () => false) => {
    for (let i = 0; i < 50 && !done(); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  };

  function Document({ path }: { path: string }) {
    const initialPage = pages[path];
    return (
      <div data-editor={path}>
        <PlateDocumentEditor
          bodyOnly
          pageScroll
          documentPath={path}
          documentSpaceId="space"
          spacePath="/space"
          projectPath="/space"
          bodyOnlyMeta={initialPage.meta}
          initialPage={initialPage}
          initialPageSpacePath="/space"
        />
      </div>
    );
  }

  function Surfaces({ b, routine }: { b?: boolean; routine?: boolean }) {
    return (
      <TooltipProvider>
        <Document path={A} />
        {b ? <Document path={B} /> : null}
        {routine ? (
          <div data-editor="routine">
            <ControlledMarkdownEditor
              value={"[Gone A](Gone%20A.md)\n"}
              onChange={() => {}}
            />
          </div>
        ) : null}
      </TooltipProvider>
    );
  }

  /** Whether the Page link pill with the text is struck; null without it. */
  function struck(editor: string, text: string): boolean | null {
    const pill = [
      ...document.querySelectorAll<HTMLElement>(
        `[data-editor="${editor}"] span.bg-accent`,
      ),
    ].find((node) => node.textContent?.includes(text));
    return pill ? pill.className.includes("line-through") : null;
  }

  const root = createRoot(document.getElementById("app")!);
  const render = (props: Parameters<typeof Surfaces>[0]) =>
    act(async () => root.render(<Surfaces {...props} />));

  test("each document editor keeps the marks of its own validation", async () => {
    await render({});
    await settle(() => struck(A, "Gone A") === true);
    expect(struck(A, "Gone A")).toBe(true);
    expect(struck(A, "Gone B")).toBe(false);

    // A second editor loads and validates its document next to the first.
    await render({ b: true });
    await settle(() => struck(B, "Gone B") === true);
    expect(struck(B, "Gone B")).toBe(true);
    expect(struck(B, "Gone A")).toBe(false);
    expect(struck(A, "Gone A")).toBe(true);
    expect(struck(A, "Gone B")).toBe(false);
  });

  test("a reload of one editor resets only its own marks", async () => {
    validations.length = 0;
    held.set(A, () => {});
    // A new provided Page of A runs its load again.
    pages[A] = page(A, `${pages[A].body}\nRevised.\n`, "v2");
    await render({ b: true });
    await settle(() => validations.includes(A));
    // The reload of A cleared its marks and waits for its validation.
    expect(struck(A, "Gone A")).toBe(false);
    expect(struck(B, "Gone B")).toBe(true);

    await act(async () => held.get(A)?.());
    held.delete(A);
    await settle(() => struck(A, "Gone A") === true);
    expect(struck(A, "Gone A")).toBe(true);
    expect(struck(B, "Gone B")).toBe(true);
    expect(struck(B, "Gone A")).toBe(false);
    expect(validations).toEqual([A]);
  });

  test("closing the second editor keeps the marks of the first without a reload", async () => {
    validations.length = 0;
    await render({});
    await settle();
    expect(document.querySelector(`[data-editor="${B}"]`)).toBeNull();
    expect(struck(A, "Gone A")).toBe(true);
    expect(struck(A, "Gone B")).toBe(false);
    expect(validations).toEqual([]);
  });

  test("a Routine field marks no link broken in another document", async () => {
    await render({ routine: true });
    await settle();
    expect(struck(A, "Gone A")).toBe(true);
    expect(struck("routine", "Gone A")).toBe(false);
  });

  test("teardown", async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
}
