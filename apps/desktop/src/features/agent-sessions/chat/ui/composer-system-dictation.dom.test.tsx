import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

// System dictation of the OS in the composer (DF-174): the event sequences
// WebKit sends when a dictation is committed, as recorded in DF-174A.
if (process.env.SVODE_COMPOSER_SYSTEM_DICTATION_DOM !== "1") {
  test("composer system dictation DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_COMPOSER_SYSTEM_DICTATION_DOM: "1" },
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  installDomGlobals(dom);
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
  const { createRoot } = await import("react-dom/client");

  const DRAFT = "session:codex:s1";
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command) => {
    if (command.startsWith("plugin:event|")) return 1;
    switch (command) {
      case "speech_models":
        return {
          models: [],
          unsupported: [],
          activeModel: null,
          recommendation: null,
        };
      case "speech_dictation_owner":
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { Composer } = await import("./composer");
  const { useComposerDraft } = await import("../hooks/use-composer-draft");
  const { readComposerDraft, writeComposerDraft } = await import("../model/composer");

  let sends = 0;
  let partsChanges = 0;

  function Harness({ sending = false }: { sending?: boolean }) {
    const [draft, update] = useComposerDraft(DRAFT);
    return (
      <Composer
        draftKey={DRAFT}
        parts={draft.parts}
        onPartsChange={(parts) => {
          partsChanges += 1;
          update({ parts });
        }}
        onSend={() => {
          sends += 1;
        }}
        onStop={() => {}}
        running={false}
        cancelling={false}
        sending={sending}
        canSend
        placeholder="Message"
      />
    );
  }

  let root: Root | null = null;
  function dictationTest(name: string, draft: string, fn: () => Promise<void>) {
    test(name, async () => {
      sends = 0;
      partsChanges = 0;
      writeComposerDraft(DRAFT, draft ? { parts: [{ type: "text", text: draft }] } : null);
      try {
        await fn();
      } finally {
        await act(async () => root?.unmount());
        root = null;
        document.body.innerHTML = "";
        window.sessionStorage.clear();
      }
    });
  }

  async function render(sending = false) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <Harness sending={sending} />
        </TooltipProvider>,
      );
    });
    await settle();
  }

  function field() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    )!;
  }

  function stored() {
    return (readComposerDraft(DRAFT)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  /** Puts the page selection in the field's text, from `start` to `end`. */
  async function select(start: number, end = start) {
    await act(async () => field().focus());
    const text =
      field().querySelector("[data-slate-string]")?.firstChild ??
      field().querySelector("[data-slate-zero-width]")?.firstChild;
    if (!text) throw new Error("no text in the field");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new window.Event("selectionchange"));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await settle();
  }

  dictationTest("form B puts the text into an empty field and its draft", "", async () => {
    await render();
    await select(0);
    await dictateFormB("Fix the import");
    expect(field().textContent).toBe("Fix the import");
    expect(stored()).toBe("Fix the import");
    expect(partsChanges > 0).toBe(true);
    expect(sends).toBe(0);
  });

  dictationTest("form B puts the text at the caret in the middle", "Please now", async () => {
    await render();
    await select("Please ".length);
    await dictateFormB("fix it ");
    expect(stored()).toBe("Please fix it now");
    expect(sends).toBe(0);
  });

  dictationTest("form B replaces the selection", "Please fix now", async () => {
    await render();
    await select("Please ".length, "Please fix".length);
    await dictateFormB("mend");
    expect(stored()).toBe("Please mend now");
    expect(sends).toBe(0);
  });

  dictationTest("form A is inserted once, by the editor", "Please ", async () => {
    await render();
    await select("Please ".length);
    await dictateFormA("fix it");
    expect(stored()).toBe("Please fix it");
    expect(field().textContent).toBe("Please fix it");
    expect(sends).toBe(0);
  });

  dictationTest("a beforeinput without inputType and textInput inserts nothing", "Please", async () => {
    await render();
    await select("Please".length);
    await compose("lost");
    await fire(new window.CompositionEvent("compositionend", { data: "", bubbles: true }));
    await beforeInput("", null);
    await beforeInput("", null);
    expect(stored()).toBe("Please");
    expect(field().textContent).toBe("Please");
  });

  dictationTest("form B does not reach a field that is sending", "Please", async () => {
    await render();
    await select("Please".length);
    await render(true);
    await dictateFormB(" more");
    expect(stored()).toBe("Please");
    expect(field().textContent).toBe("Please");
  });

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

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CompositionEvent: dom.window.CompositionEvent,
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    InputEvent: dom.window.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
}
