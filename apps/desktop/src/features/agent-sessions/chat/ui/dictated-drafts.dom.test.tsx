import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_DICTATED_DRAFTS_DOM !== "1") {
  test("dictated drafts DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_DICTATED_DRAFTS_DOM: "1" },
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
  const { createRoot } = await import("react-dom/client");

  const DRAFT = "session:codex:s1";
  const OTHER = "new:/project/space";
  /** What Desktop recognized after the reload and keeps for this webview. */
  let waiting: { key: string; text: string }[] = [];
  let takes = 0;

  const { mockNativeIpc, mockNativeWindow } = await import("@/platform/native/testing");
  mockNativeWindow("main");
  mockNativeIpc(
    (command) => {
      switch (command) {
        case "speech_dictated_texts": {
          takes += 1;
          const texts = waiting;
          waiting = [];
          return texts;
        }
        case "speech_models":
          return {
            models: [],
            unsupported: [],
            activeModel: null,
            recommendation: { modelId: "turbo", model: "accurate", measured: false, accurateSlow: false },
          };
        case "speech_dictation_owner":
          return null;
        default:
          throw new Error(`unexpected command ${command}`);
      }
    },
    { shouldMockEvents: true },
  );

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { emit } = await import("@/platform/native/events");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { Composer } = await import("./composer");
  const { useDictatedDrafts } = await import("../hooks/use-dictated-drafts");
  const { useComposerDraft } = await import("../hooks/use-composer-draft");
  const { readComposerDraft, writeComposerDraft } = await import("../model/composer");

  const sent: string[] = [];

  /** The window: its draft delivery, and the composer of `DRAFT` when shown. */
  function Window({ shown }: { shown: boolean }) {
    useDictatedDrafts();
    return shown ? <SessionComposer /> : null;
  }

  function SessionComposer() {
    const [draft, update] = useComposerDraft(DRAFT);
    return (
      <Composer
        draftKey={DRAFT}
        parts={draft.parts}
        onPartsChange={(parts) => update({ parts })}
        onSend={() => sent.push(storedText(DRAFT))}
        onStop={() => undefined}
        running={false}
        cancelling={false}
        sending={false}
        canSend
        placeholder="Message"
      />
    );
  }

  let root: Root | null = null;
  function deliveryTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      waiting = [];
      takes = 0;
      sent.length = 0;
      writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Please" }] });
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

  async function render(shown: boolean) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <Window shown={shown} />
        </TooltipProvider>,
      );
    });
    await settle();
  }

  async function ready(webview: string) {
    await act(async () => {
      await emit("speech-dictated-text", webview);
    });
    await settle();
  }

  function storedText(key: string) {
    return (readComposerDraft(key)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  function composerText() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    )?.textContent;
  }

  deliveryTest("text ready at load goes after the draft of its key, with its composer closed", async () => {
    waiting = [
      { key: DRAFT, text: " fix the import" },
      { key: OTHER, text: "start a review" },
    ];
    await render(false);
    expect(storedText(DRAFT)).toBe("Please fix the import");
    expect(storedText(OTHER)).toBe("start a review");
    // The session opened afterwards shows it.
    await render(true);
    expect(composerText()).toBe("Please fix the import");
    expect(sent).toEqual([]);
  });

  deliveryTest("text ready later shows in the open composer at once and is not sent", async () => {
    await render(true);
    expect(takes).toBe(1);
    waiting = [{ key: DRAFT, text: "and the tests" }];
    // A text for another webview is not this window's.
    await ready("other");
    expect(takes).toBe(1);
    expect(storedText(DRAFT)).toBe("Please");
    await ready("main");
    expect(storedText(DRAFT)).toBe("Please and the tests");
    expect(composerText()).toBe("Please and the tests");
    expect(sent).toEqual([]);
  });

  deliveryTest("a delivered text is not appended again", async () => {
    waiting = [{ key: DRAFT, text: "once" }];
    await render(false);
    await ready("main");
    // The window mounts its delivery anew.
    await act(async () => root?.unmount());
    root = null;
    await render(false);
    expect(storedText(DRAFT)).toBe("Please once");
  });

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
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
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
