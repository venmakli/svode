import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_COMPOSER_DICTATION_DOM !== "1") {
  test("composer dictation DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_COMPOSER_DICTATION_DOM: "1" },
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
  /** Calls of the speech commands, with their arguments. */
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  let activeModel: string | null = "turbo";
  let owner: unknown = null;
  /** How the next recognitions end, in order. */
  let results: unknown[] = [];

  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    if (command.startsWith("plugin:event|")) return 1;
    calls.push({ command, payload });
    switch (command) {
      case "speech_models":
        return {
          models: [
            {
              id: "turbo",
              name: "Whisper large-v3-turbo",
              family: "whisper",
              mark: "accurate",
              size: 886_000_000,
              languages: { ru: "ru", en: "en" },
              detectsLanguage: true,
              installation: activeModel ? "current" : null,
              installedSize: null,
              measurement: null,
              job: null,
            },
          ],
          unsupported: [],
          activeModel,
          recommendation: { modelId: "turbo", model: "accurate", measured: false, accurateSlow: false },
        };
      case "speech_dictation_owner":
        return owner;
      case "speech_dictation_start":
        return null;
      case "speech_dictation_finish":
        return results.shift() ?? { outcome: "failed", failure: { code: "cancelled" } };
      case "speech_dictation_cancel":
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
  const { registerVoiceSettingsOpener } = await import("@/features/voice-input");
  const { useComposerDraft } = await import("../hooks/use-composer-draft");
  const { readComposerDraft, writeComposerDraft } = await import("../model/composer");

  /** What each send carried. */
  const sent: string[] = [];
  let stops = 0;

  function Harness({ shown }: { shown: boolean }) {
    const [draft, update] = useComposerDraft(DRAFT);
    const text = draft.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    if (!shown) return <output data-draft="">{text}</output>;
    return (
      <Composer
        draftKey={DRAFT}
        parts={draft.parts}
        onPartsChange={(parts) => update({ parts })}
        onSend={() => sent.push(text)}
        onStop={() => {
          stops += 1;
        }}
        running={false}
        cancelling={false}
        sending={false}
        canSend
        placeholder="Message"
      />
    );
  }

  let root: Root | null = null;
  function dictationTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      calls.length = 0;
      sent.length = 0;
      stops = 0;
      activeModel = "turbo";
      owner = null;
      results = [];
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

  async function render(shown = true) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <Harness shown={shown} />
        </TooltipProvider>,
      );
    });
    await settle();
  }

  function composerField() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    );
  }

  function storedText() {
    return (readComposerDraft(DRAFT)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  function button(label: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.getAttribute("aria-label") === label,
    );
  }

  function buttonWithText(text: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === text,
    );
  }

  const microphone = () => button(m.voice_input_start({ shortcut: "Ctrl+Shift+M" }));
  const count = (command: string) => calls.filter((call) => call.command === command).length;

  dictationTest("■ puts the text after the draft for editing and sends nothing", async () => {
    await render();
    await click(microphone());
    expect(count("speech_dictation_start")).toBe(1);
    expect(calls.find((call) => call.command === "speech_dictation_start")?.payload.key).toBe(DRAFT);
    expect(Boolean(document.querySelector(`[aria-label="${m.voice_input_recording()}"]`))).toBe(true);
    results = [{ outcome: "text", text: " fix the import" }];
    await click(button(m.voice_input_stop()));
    expect(storedText()).toBe("Please fix the import");
    expect(sent).toEqual([]);
    // The bottom row is back.
    expect(Boolean(microphone())).toBe(true);
  });

  dictationTest("↑ sends the draft with the dictated text", async () => {
    await render();
    await click(microphone());
    results = [{ outcome: "text", text: "now" }];
    await click(button(m.voice_input_stop_and_send()));
    expect(sent).toEqual(["Please now"]);
  });

  dictationTest("a failed recognition keeps the draft and retries the same audio", async () => {
    await render();
    await click(microphone());
    results = [{ outcome: "failed", failure: { code: "recognition" } }];
    await click(button(m.voice_input_stop()));
    expect(document.body.textContent?.includes(m.voice_input_failed_recognition())).toBe(true);
    expect(storedText()).toBe("Please");
    results = [{ outcome: "text", text: "again" }];
    await click(buttonWithText(m.voice_input_retry()));
    expect(count("speech_dictation_finish")).toBe(2);
    expect(count("speech_dictation_start")).toBe(1);
    expect(storedText()).toBe("Please again");
  });

  dictationTest("a recording without signal is not recognized text and leaves the draft", async () => {
    await render();
    await click(microphone());
    results = [{ outcome: "failed", failure: { code: "noSignal", soundSettings: true } }];
    await click(button(m.voice_input_stop()));
    expect(document.body.textContent?.includes(m.voice_input_failed_no_signal())).toBe(true);
    expect(Boolean(buttonWithText(m.voice_input_open_sound_settings()))).toBe(true);
    expect(buttonWithText(m.voice_input_retry())).toBe(undefined);
    // The audio is already gone; ✕ only closes the row.
    await click(button(m.voice_input_cancel()));
    expect(Boolean(microphone())).toBe(true);
    expect(storedText()).toBe("Please");
  });

  dictationTest("Esc cancels the recording, not the turn, and the draft stays", async () => {
    await render();
    await click(microphone());
    // The microphone went with the bottom row; the focus is back in the field.
    expect(composerField()?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(count("speech_dictation_cancel")).toBe(1);
    expect(stops).toBe(0);
    expect(storedText()).toBe("Please");
    expect(Boolean(microphone())).toBe(true);
  });

  dictationTest("in a peek the focus comes back from the peek to the field and Esc stays there", async () => {
    await render();
    // A peek's content is focusable, so pressing the microphone in WebKit
    // leaves the focus on the peek around the composer, not on the page.
    const peek = document.body.firstElementChild as HTMLElement;
    peek.tabIndex = -1;
    let peekEscapes = 0;
    peek.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && event.target === peek) peekEscapes += 1;
    });
    await act(async () => peek.focus());
    await click(microphone());
    expect(composerField()?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(count("speech_dictation_cancel")).toBe(1);
    expect(peekEscapes).toBe(0);
    expect(storedText()).toBe("Please");
  });

  dictationTest("the hotkey starts and stops as ■", async () => {
    await render();
    const field = composerField();
    await act(async () => field?.focus());
    const hotkey = () =>
      act(async () => {
        field?.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "M",
            code: "KeyM",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    await hotkey();
    await settle();
    expect(count("speech_dictation_start")).toBe(1);
    results = [{ outcome: "text", text: "hands free" }];
    await hotkey();
    await settle();
    expect(storedText()).toBe("Please hands free");
    expect(sent).toEqual([]);
  });

  dictationTest("a composer that goes while recording stops as ■ into its kept draft", async () => {
    await render();
    await click(microphone());
    results = [{ outcome: "text", text: "from outside" }];
    // Another session, a closed peek or the agent's request card.
    await render(false);
    expect(count("speech_dictation_finish")).toBe(1);
    expect(document.querySelector("[data-draft]")?.textContent).toBe("Please from outside");
    expect(sent).toEqual([]);
  });

  dictationTest("without a model the microphone opens the enable popover", async () => {
    activeModel = null;
    await render();
    await click(button(m.voice_input_title()));
    expect(count("speech_dictation_start")).toBe(0);
    expect(Boolean(buttonWithText(m.voice_input_download({ size: 886 })))).toBe(true);
    // Without the app shell there is nowhere to show other models.
    expect(buttonWithText(m.voice_input_other_models())).toBe(undefined);
  });

  dictationTest("“Other models…” closes the popover and opens the voice input settings", async () => {
    activeModel = null;
    let opened = 0;
    const unregister = registerVoiceSettingsOpener(() => {
      opened += 1;
    });
    try {
      await render();
      await click(button(m.voice_input_title()));
      await click(buttonWithText(m.voice_input_other_models()));
      expect(opened).toBe(1);
      expect(buttonWithText(m.voice_input_download({ size: 886 }))).toBe(undefined);
    } finally {
      unregister();
    }
  });

  dictationTest("the microphone waits while another session records", async () => {
    owner = { webview: "", key: "session:codex:other" };
    await render();
    const busy = button(m.voice_input_busy());
    expect(busy?.hasAttribute("disabled")).toBe(true);
  });

  async function click(element: Element | undefined) {
    if (!element) throw new Error("nothing to click");
    await act(async () => {
      element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
      element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0 }));
      element.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      (element as HTMLElement).click();
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
