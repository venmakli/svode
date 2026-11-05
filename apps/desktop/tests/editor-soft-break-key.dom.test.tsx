import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Shift+Enter in a field on `EditorKit` (DF-248 R3): one hard line break in
// the same paragraph, written `\` + LF, on WebKit and Chromium alike. The
// browser fires `beforeinput` only for a keydown nobody prevented: WebKit
// with `insertParagraph` for Shift+Enter, Chromium with `insertLineBreak`.
if (process.env.SVODE_EDITOR_SOFT_BREAK_KEY_DOM !== "1") {
  test("editor Shift+Enter DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_EDITOR_SOFT_BREAK_KEY_DOM: "1" },
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
  // Slate listens to native `beforeinput` only where the engine has
  // `getTargetRanges`, as WebKit and Chromium do; jsdom lacks it.
  Object.defineProperty(dom.window.InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => [],
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "Node",
    "NodeFilter",
    "NodeList",
    "HTMLCollection",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Document",
    "DocumentFragment",
    "MutationObserver",
    "DOMParser",
    "DOMRect",
    "Range",
    "Selection",
    "Text",
    "KeyboardEvent",
    "MouseEvent",
    "InputEvent",
    "Event",
    "CustomEvent",
    "ShadowRoot",
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
  // Slate scrolls the caret into view after an insert.
  for (const key of ["innerWidth", "innerHeight"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  }
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return (
        this.closest("[contenteditable]")?.getAttribute("contenteditable") ===
        "true"
      );
    },
  });
  const rect = () => new dom.window.DOMRect(0, 0, 0, 0);
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () =>
    [] as unknown as DOMRectList;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { ControlledMarkdownEditor } = await import("../src/features/editor");
  const { mockNativeIpc } = await import("../src/platform/native/testing");
  mockNativeIpc(() => null);

  const SOURCE = "Other paragraph here.\n\nNext\n";

  /** The input type each engine reports for Shift+Enter. */
  const engines = [
    ["WebKit", "insertParagraph"],
    ["Chromium", "insertLineBreak"],
  ] as const;

  for (const [engine, inputType] of engines) {
    test(`Shift+Enter on ${engine} inserts one hard line break in the paragraph`, async () => {
      await withField(async (changes) => {
        await caretIn("Other paragraph here.", "Oth".length);
        await press({ shiftKey: true }, inputType);
        expect(paragraphs()).toEqual(["Oth\ner paragraph here.", "Next"]);
        expect(changes.at(-1)).toBe("Oth\\\ner paragraph here.\n\nNext\n");
      });
    });
  }

  test("Enter still splits the paragraph", async () => {
    await withField(async (changes) => {
      await caretIn("Other paragraph here.", "Oth".length);
      expect(await press({}, "insertParagraph")).toBe(false);
      expect(paragraphs()).toEqual(["Oth", "er paragraph here.", "Next"]);
      expect(changes.at(-1)).toBe("Oth\n\ner paragraph here.\n\nNext\n");
    });
  });

  test("Shift+Enter that commits a composition is left to the composition", async () => {
    await withField(async () => {
      await caretIn("Other paragraph here.", "Oth".length);
      for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
        const event = keydown({ shiftKey: true, ...composing });
        await act(async () => {
          field().dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(false);
      }
      expect(paragraphs()).toEqual(["Other paragraph here.", "Next"]);
    });
  });

  async function withField(fn: (changes: string[]) => Promise<void>) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: string[] = [];
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ControlledMarkdownEditor
              value={SOURCE}
              onChange={(value) => changes.push(value)}
            />
          </TooltipProvider>,
        );
      });
      await settle();
      await fn(changes);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }

  function field() {
    return document.querySelector<HTMLElement>("[data-slate-editor]")!;
  }

  function paragraphs() {
    return [...field().querySelectorAll("[data-slate-node=element]")]
      .filter(
        (element) =>
          !element.parentElement?.closest("[data-slate-node=element]"),
      )
      .map((element) =>
        [...element.querySelectorAll("[data-slate-string]")]
          .map((node) => node.textContent)
          .join(""),
      );
  }

  function keydown(init: KeyboardEventInit & { keyCode?: number }) {
    const { keyCode, ...rest } = init;
    const event = new window.KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      ...rest,
    });
    if (keyCode !== undefined) {
      Object.defineProperty(event, "keyCode", { value: keyCode });
    }
    return event;
  }

  /**
   * Presses Enter at the field as the engine does: keydown, then the engine's
   * `beforeinput` unless the keydown was prevented. True when the keydown was
   * taken.
   */
  async function press(modifiers: KeyboardEventInit, inputType: string) {
    const event = keydown(modifiers);
    await act(async () => {
      field().dispatchEvent(event);
    });
    if (!event.defaultPrevented) {
      await act(async () => {
        field().dispatchEvent(
          new window.InputEvent("beforeinput", {
            inputType,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
    await settle();
    return event.defaultPrevented;
  }

  async function caretIn(text: string, offset: number) {
    const node = [...field().querySelectorAll("[data-slate-string]")].find(
      (string) => string.textContent === text,
    )!.firstChild!;
    await act(async () => field().focus());
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new window.Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await settle();
  }

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
}
