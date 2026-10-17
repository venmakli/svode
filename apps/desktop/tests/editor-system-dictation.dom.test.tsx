import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// System dictation of the OS in a field on `EditorKit` (DF-174): the event
// sequences WebKit sends when a dictation is committed, as recorded in
// DF-174A.
if (process.env.SVODE_EDITOR_SYSTEM_DICTATION_DOM !== "1") {
  test("editor system dictation DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_EDITOR_SYSTEM_DICTATION_DOM: "1" },
      encoding: "utf8",
    });
    expect(child.status, child.stdout + child.stderr).toBe(0);
  }, 30000);
} else {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
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
    "CompositionEvent",
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
  // Input reaches Slate only in an editable field, as `beforeinput` as in
  // WebKit.
  Object.defineProperty(dom.window.HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true";
    },
  });
  Object.defineProperty(dom.window.InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => [],
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { ControlledMarkdownEditor } = await import("../src/features/editor");

  function field() {
    return document.querySelector<HTMLElement>("[data-slate-editor]")!;
  }

  async function withField(
    source: string,
    fn: (changes: string[]) => Promise<void>,
    disabled = false,
  ) {
    const root = createRoot(document.getElementById("app")!);
    const changes: string[] = [];
    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ControlledMarkdownEditor
              disabled={disabled}
              value={source}
              onChange={(value) => changes.push(value)}
            />
          </TooltipProvider>,
        );
      });
      await settle();
      await fn(changes);
    } finally {
      await act(async () => root.unmount());
    }
  }

  test("form B puts the text at the caret and the field reports the change", async () => {
    await withField("Intro text\n", async (changes) => {
      await select("Intro ".length);
      await dictateFormB("dictated ");
      expect(field().textContent).toContain("Intro dictated text");
      expect(changes.at(-1)).toBe("Intro dictated text\n");
    });
  });

  test("form B puts the text into an empty field", async () => {
    await withField("", async (changes) => {
      await select(0);
      await dictateFormB("Dictated");
      expect(changes.at(-1)).toBe("Dictated\n");
    });
  });

  test("form A is inserted once, by the editor", async () => {
    await withField("Intro\n", async (changes) => {
      await select("Intro".length);
      await dictateFormA(" more");
      expect(changes.at(-1)).toBe("Intro more\n");
    });
  });

  test("a beforeinput without inputType and textInput inserts nothing", async () => {
    await withField("Intro\n", async (changes) => {
      await select("Intro".length);
      await compose("lost");
      await fire(new window.CompositionEvent("compositionend", { data: "", bubbles: true }));
      await beforeInput("", null);
      expect(changes).toEqual([]);
      expect(field().textContent).toBe("Intro");
    });
  });

  test("a read-only field takes no dictation", async () => {
    await withField(
      "Intro\n",
      async (changes) => {
        await select("Intro".length);
        await dictateFormB(" more");
        expect(changes).toEqual([]);
        expect(field().textContent).toBe("Intro");
      },
      true,
    );
  });

  /** Puts the page selection in the field's first text at `offset`. */
  async function select(offset: number) {
    await act(async () => field().focus());
    const text =
      field().querySelector("[data-slate-string]")?.firstChild ??
      field().querySelector("[data-slate-zero-width]")?.firstChild;
    if (!text) throw new Error("no text in the field");
    const range = document.createRange();
    range.setStart(text, offset);
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

  /** Marked text while the dictation runs, then its removal. */
  async function compose(text: string) {
    await fire(new window.CompositionEvent("compositionstart", { data: "", bubbles: true }));
    await fire(new window.CompositionEvent("compositionupdate", { data: text, bubbles: true }));
    await beforeInput("insertCompositionText", text);
    await beforeInput("deleteCompositionText", null);
  }

  async function dictateFormB(text: string) {
    await compose(text);
    await fire(new window.CompositionEvent("compositionend", { data: "", bubbles: true }));
    await fire(textInput(text));
    await beforeInput("", null);
  }

  async function dictateFormA(text: string) {
    await compose(text);
    await fire(textInput(text));
    await beforeInput("insertFromComposition", text);
    await fire(new window.CompositionEvent("compositionend", { data: text, bubbles: true }));
  }

  function textInput(text: string) {
    const event = new window.Event("textInput", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "data", { value: text });
    return event;
  }

  async function beforeInput(inputType: string, data: string | null) {
    const target = eventTarget();
    await act(async () => {
      const event = new window.InputEvent("beforeinput", {
        inputType,
        data,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      if (!event.defaultPrevented) {
        target.dispatchEvent(new window.InputEvent("input", { inputType, data, bubbles: true }));
      }
    });
    await settle();
  }

  async function fire(event: Event) {
    const target = eventTarget();
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
  }

  /** WebKit sends input events to the node of the caret. */
  function eventTarget() {
    const anchor = document.getSelection()?.anchorNode;
    const node = anchor && field().contains(anchor) ? anchor : field();
    return node.nodeType === window.Node.TEXT_NODE ? node.parentElement! : (node as HTMLElement);
  }

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
}
