import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";

if (process.env.SVODE_COMMENT_MARKER_DOM !== "1") {
  test("Markdown comment markers DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_COMMENT_MARKER_DOM: "1" },
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
  // Slate handles keys only in an editable target, which JSDOM cannot tell.
  Object.defineProperty(dom.window.HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return (
        this.closest("[contenteditable]")?.getAttribute("contenteditable") ===
        "true"
      );
    },
  });
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
  const m = await import("../src/paraglide/messages.js");
  const plate = await import("platejs/react");
  const useActualPlateEditor = plate.usePlateEditor;
  let mountedEditor: ReturnType<typeof plate.usePlateEditor> | undefined;
  mock.module("platejs/react", () => ({
    ...plate,
    usePlateEditor: (...args: Parameters<typeof plate.usePlateEditor>) => {
      const editor = useActualPlateEditor(...args);
      mountedEditor = editor;
      return editor;
    },
  }));
  const { mockNativeIpc } = await import("../src/platform/native/testing");
  const { ControlledMarkdownEditor } =
    await import("../src/features/editor/plate/controlled-markdown-editor");
  const { PlateDocumentEditor } =
    await import("../src/features/editor/plate/plate-editor");

  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  };
  const markers = () => [
    ...document.querySelectorAll<HTMLElement>(
      "[data-slate-editor] [role=note]",
    ),
  ];
  const marker = (name: string) =>
    markers().find((el) => el.getAttribute("aria-label") === name);
  const named = (text: string) => m.editor_markdown_comment_name({ text });

  async function mountRoutineEditor(
    source: string,
    changes: string[],
    disabled = false,
  ) {
    const root = createRoot(document.getElementById("app")!);
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <ControlledMarkdownEditor
            disabled={disabled}
            value={source}
            onChange={(value) => changes.push(value)}
          />
        </TooltipProvider>,
      );
    });
    return root;
  }

  const KEY_CODES: Record<string, number> = { Backspace: 8, z: 90 };

  // Slate matches hotkeys by key code, and react-hotkeys stops keys that do
  // not come from the focused editor.
  async function press(key: string, init: KeyboardEventInit = {}) {
    const editable = document.querySelector<HTMLElement>(
      "[data-slate-editor]",
    )!;
    await act(async () => {
      editable.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          keyCode: KEY_CODES[key],
          which: KEY_CODES[key],
          bubbles: true,
          cancelable: true,
          ...init,
        } as KeyboardEventInit),
      );
    });
  }

  async function placeCaret(at: { path: number[]; offset: number }) {
    await act(async () => {
      document.querySelector<HTMLElement>("[data-slate-editor]")!.focus();
    });
    await act(async () => {
      mountedEditor!.tf.select(at);
    });
  }

  test("markers render in a paragraph, list, quote and table cell with an accessible name", async () => {
    const source = [
      "Para <!-- in paragraph --> text",
      "",
      "<!--",
      "  first line",
      "    second line",
      "-->",
      "",
      "- item <!-- in list -->",
      "  <!-- block in list -->",
      "",
      "> quote <!-- in quote -->",
      "",
      "| A | B |",
      "| --- | --- |",
      "| cell <!-- in cell --> | x |",
      "",
      "{/* mdx form */}",
      "",
      "[//]: # (definition form)",
      "",
      "<!-- -->",
      "",
      "End",
      "",
    ].join("\n");
    const changes: string[] = [];
    const root = await mountRoutineEditor(source, changes);
    try {
      const inline = (text: string) => {
        const el = marker(named(text));
        expect(el, text).toBeDefined();
        expect(el!.tagName).toBe("SPAN");
        expect(el!.getAttribute("contenteditable")).toBe("false");
        return el!;
      };
      const container = (el: HTMLElement) =>
        ["blockquote", "td", "li"].find((tag) => el.closest(tag)) ?? "p";
      expect(container(inline("in paragraph"))).toBe("p");
      expect(container(inline("in list"))).toBe("li");
      expect(container(inline("in quote"))).toBe("blockquote");
      expect(container(inline("in cell"))).toBe("td");

      const block = marker(named("first line\n  second line"))!;
      expect(block.tagName).toBe("DIV");
      expect(block.textContent).toBe(
        `${m.editor_markdown_comment()}first line`,
      );
      expect(Boolean(marker(named("block in list")))).toBe(true);
      expect(Boolean(marker(named("mdx form")))).toBe(true);
      expect(Boolean(marker(named("definition form")))).toBe(true);

      const empty = marker(m.editor_markdown_comment())!;
      expect(empty.textContent).toBe(m.editor_markdown_comment());
      expect(markers().length).toBe(9);

      // Markers show only the start of the text: the raw source is not in the line.
      const text = document.querySelector("[data-slate-editor]")!.textContent!;
      expect(text.includes("<!--")).toBe(false);
      expect(text.includes("second line")).toBe(false);
      expect(changes.length).toBe(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("Tooltip shows the full multi-line comment text", async () => {
    const source = "<!--\n  first line\n    second line\n-->\n\nAfter\n";
    const root = await mountRoutineEditor(source, []);
    try {
      const block = marker(named("first line\n  second line"))!;
      await act(async () => {
        block.dispatchEvent(
          new window.PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
          }),
        );
      });
      await settle();
      const content = document.querySelector("[data-slot=tooltip-content]");
      expect(Boolean(content)).toBe(true);
      expect(content!.textContent!.includes("first line\n  second line")).toBe(
        true,
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("Backspace removes a marker whole and Undo brings it back", async () => {
    const source = "Before\n\n<!-- block -->\n\nIntro <!-- inline --> tail\n";
    const changes: string[] = [];
    const root = await mountRoutineEditor(source, changes);
    try {
      const editor = mountedEditor!;
      // As with other void blocks, the first Backspace selects the marker.
      await placeCaret({ path: [2, 0], offset: 0 });
      await press("Backspace");
      expect(JSON.stringify(editor.selection?.anchor.path)).toBe("[1,0]");
      expect(changes.length).toBe(0);
      await press("Backspace");
      expect(changes.at(-1)).toBe("Before\n\nIntro <!-- inline --> tail\n");
      expect(Boolean(marker(named("block")))).toBe(false);

      await press("z", { ctrlKey: true });
      expect(changes.at(-1)).toBe(source);
      expect(Boolean(marker(named("block")))).toBe(true);

      const inlinePath = editor.api.node({
        at: [],
        match: { type: "markdown_comment_inline" },
      })![1];
      const after = [...inlinePath.slice(0, -1), inlinePath.at(-1)! + 1];
      await placeCaret({ path: after, offset: 0 });
      await press("Backspace");
      expect(changes.at(-1)).toBe("Before\n\n<!-- block -->\n\nIntro  tail\n");
      expect(Boolean(marker(named("inline")))).toBe(false);

      await press("z", { ctrlKey: true });
      expect(changes.at(-1)).toBe(source);
      expect(Boolean(marker(named("inline")))).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("read-only field shows the same markers and does not delete them", async () => {
    const source = "Before\n\n<!-- block -->\n\nIntro <!-- inline --> tail\n";
    const changes: string[] = [];
    const root = await mountRoutineEditor(source, changes, true);
    try {
      expect(marker(named("block"))!.textContent).toBe(
        `${m.editor_markdown_comment()}block`,
      );
      expect(Boolean(marker(named("inline")))).toBe(true);
      await placeCaret({ path: [2, 0], offset: 0 });
      await press("Backspace");
      await press("Backspace");
      expect(changes.length).toBe(0);
      expect(Boolean(marker(named("block")))).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("Page TOC lists headings without comment markers", async () => {
    const meta = { title: "Goal" } as never;
    const page = {
      meta,
      body: "## Focus <!-- hidden -->\n\n<!-- block note -->\n\nFirst.\n\n## Key Results\n\nSecond.\n",
      path: "goal.md",
      source_version: "v1",
    };
    mockNativeIpc((cmd) => {
      if (cmd === "read_page") return page;
      if (cmd === "validate_links") return [];
      return null;
    });
    const root = createRoot(document.getElementById("app")!);
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <PlateDocumentEditor
              bodyOnly
              pageScroll
              documentPath={page.path}
              documentSpaceId="space"
              spacePath="/space"
              projectPath="/space"
              bodyOnlyMeta={meta}
              initialPage={page as never}
              initialPageSpacePath="/space"
            />
          </TooltipProvider>,
        );
      });
      await settle();
      expect(Boolean(marker(named("hidden")))).toBe(true);
      expect(Boolean(marker(named("block note")))).toBe(true);
      await act(async () => {
        document
          .querySelector("nav")!
          .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      const entries = [...document.querySelectorAll("nav button")].map(
        (button) => button.textContent?.trim(),
      );
      expect(entries.join("|")).toBe("Focus|Key Results");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}
