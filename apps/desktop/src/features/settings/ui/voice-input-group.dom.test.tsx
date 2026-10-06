import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_VOICE_INPUT_GROUP_DOM !== "1") {
  test("voice input settings DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_VOICE_INPUT_GROUP_DOM: "1" },
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
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  const { createRoot } = await import("react-dom/client");

  function model(id: string, init: Record<string, unknown> = {}) {
    return {
      id,
      name: id,
      family: "whisper",
      size: 886_000_000,
      languages: { ru: "ru", en: "en" },
      detectsLanguage: true,
      installation: null,
      installedSize: null,
      measurement: null,
      job: null,
      ...init,
    };
  }

  let state: Record<string, unknown> = {};
  function catalog(init: Record<string, unknown> = {}) {
    state = {
      models: [
        model("turbo", { name: "Turbo", mark: "accurate", installation: "current", installedSize: 886_000_000 }),
        model("parakeet", { name: "Parakeet", mark: "fast", size: 740_000_000 }),
        model("gigaam", {
          name: "GigaAM",
          size: 273_000_000,
          languages: { ru: "ru" },
          detectsLanguage: false,
          installation: "current",
          installedSize: 273_000_000,
        }),
      ],
      unsupported: [],
      activeModel: "turbo",
      language: null,
      recommendation: { modelId: "turbo", model: "accurate", measured: false, accurateSlow: false },
      ...init,
    };
  }

  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    if (command.startsWith("plugin:event|")) return 1;
    calls.push({ command, payload: (args ?? {}) as Record<string, unknown> });
    switch (command) {
      case "speech_models":
        return state;
      case "speech_model_activate":
      case "speech_model_install":
      case "speech_model_delete":
      case "speech_language_set":
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });

  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { VoiceInputGroup } = await import("./voice-input-group");
  const document = dom.window.document;

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function mount(): Promise<Root> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<VoiceInputGroup />));
    await settle();
    return root;
  }

  async function unmount(root: Root) {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    calls.length = 0;
  }

  function findCombobox(label: string): HTMLElement | null {
    const id = Array.from(document.querySelectorAll("label")).find(
      (node) => node.textContent === label,
    )?.htmlFor;
    return id ? document.getElementById(id) : null;
  }

  function combobox(label: string): HTMLElement {
    const trigger = findCombobox(label);
    if (!trigger) throw new Error(`no select ${label}`);
    return trigger;
  }

  async function key(target: Element, value: string) {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }));
    });
    await settle();
  }

  async function open(trigger: HTMLElement): Promise<HTMLElement[]> {
    await act(async () => trigger.focus());
    await key(trigger, "ArrowDown");
    return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  }

  async function choose(option: HTMLElement) {
    await act(async () => option.focus());
    await key(option, "Enter");
  }

  async function click(target: Element) {
    await act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await settle();
  }

  function button(text: string, scope: ParentNode = document): HTMLElement {
    const found = Array.from(scope.querySelectorAll<HTMLElement>("button")).find(
      (node) => node.textContent === text,
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
  }

  function commands(name: string) {
    return calls.filter((call) => call.command === name).map((call) => call.payload);
  }

  test("the select lists the catalog with sizes, languages and the recommendation of V7", async () => {
    catalog({ recommendation: { modelId: "parakeet", model: "fast", measured: true, accurateSlow: true } });
    const root = await mount();
    const trigger = combobox("Model");
    expect(trigger.textContent).toBe("Turbo");
    const options = await open(trigger);
    expect(options.map((option) => option.textContent)).toEqual([
      "Turbo886 MB · Русский, English · Accurate · Installed",
      "Parakeet740 MB · Русский, English · Recommended for this computer · Fast",
      "GigaAM273 MB · Russian only · Installed",
    ]);
    // After a slow measurement the row offers the fast model.
    expect(document.body.textContent.includes("Recognition with this model is slow")).toBe(true);
    await unmount(root);
  });

  test("an installed model becomes active, one to download asks to confirm its size", async () => {
    catalog();
    const root = await mount();
    await choose((await open(combobox("Model")))[2]);
    expect(commands("speech_model_activate")).toEqual([{ id: "gigaam" }]);

    await choose((await open(combobox("Model")))[1]);
    const dialog = document.querySelector("[data-voice-model-download]")!;
    expect(dialog.textContent.includes("Download Parakeet?")).toBe(true);
    expect(dialog.textContent.includes("740 MB")).toBe(true);
    expect(commands("speech_model_install")).toEqual([]);
    await click(button("Download (740 MB)", dialog));
    expect(commands("speech_model_install")).toEqual([{ id: "parakeet" }]);
    await unmount(root);
  });

  test("the speech language offers only the languages of the active model", async () => {
    catalog({ language: "en" });
    let root = await mount();
    const trigger = combobox("Speech language");
    expect(trigger.textContent).toBe("English");
    const options = await open(trigger);
    expect(options.map((option) => option.textContent)).toEqual(["Auto", "Русский", "English"]);
    await choose(options[0]);
    expect(commands("speech_language_set")).toEqual([{ language: null }]);
    await unmount(root);

    // A model of one language names it and offers no choice.
    catalog({ activeModel: "gigaam" });
    root = await mount();
    const only = combobox("Speech language") as HTMLButtonElement;
    expect(only.textContent).toBe("Русский");
    expect(only.disabled).toBe(true);
    expect(document.body.textContent.includes("The model recognizes this language only.")).toBe(true);
    await unmount(root);

    // Without an active model there is no language to choose.
    catalog({ activeModel: null });
    root = await mount();
    expect(findCombobox("Speech language")).toBeNull();
    expect(combobox("Model").textContent).toBe("Not chosen");
    await unmount(root);
  });

  test("removing the active model is confirmed, another one goes at once", async () => {
    catalog({
      models: [
        model("turbo", { name: "Turbo", installation: "current", installedSize: 886_000_000 }),
        model("gigaam", {
          name: "GigaAM",
          languages: { ru: "ru" },
          installation: "outdated",
          installedSize: 270_000_000,
          size: 273_000_000,
        }),
      ],
      unsupported: [{ id: "gone", file: "gone.gguf", size: 50_000_000 }],
    });
    const root = await mount();
    await click(button("Show"));
    expect(document.body.textContent.includes("Installed models (3, 1.2 GB)")).toBe(true);
    expect(document.body.textContent.includes("270 MB · A new version of the file is available")).toBe(true);
    expect(document.body.textContent.includes("50 MB · Not supported")).toBe(true);

    await click(button("Update (273 MB)"));
    expect(commands("speech_model_install")).toEqual([{ id: "gigaam" }]);

    const removes = Array.from(document.querySelectorAll<HTMLElement>("button")).filter(
      (node) => node.textContent === "Delete",
    );
    await click(removes[1]);
    expect(commands("speech_model_delete")).toEqual([{ id: "gigaam" }]);

    await click(removes[0]);
    const dialog = document.querySelector("[data-voice-model-remove]")!;
    expect(dialog.textContent.includes("Voice input will be unavailable until another installed model is chosen.")).toBe(true);
    expect(commands("speech_model_delete")).toEqual([{ id: "gigaam" }]);
    await click(button("Delete", dialog));
    expect(commands("speech_model_delete")).toEqual([{ id: "gigaam" }, { id: "turbo" }]);
    await unmount(root);
  });
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
