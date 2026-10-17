import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// ⌘K / Ctrl+K in a field on `EditorKit` (DF-149 R2): the link panel when a
// link applies to the selection, else Search, never both. The window listener
// stands for the shell, which opens Search on the same physical key unless
// the event was taken.
if (process.env.SVODE_EDITOR_LINK_SHORTCUT_DOM !== "1") {
  test("editor link shortcut DOM in an isolated process", () => {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, SVODE_EDITOR_LINK_SHORTCUT_DOM: "1" },
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
  // The link panel is positioned at the selection.
  const rect = () => new dom.window.DOMRect(0, 0, 0, 0);
  dom.window.Range.prototype.getBoundingClientRect = rect;
  dom.window.Range.prototype.getClientRects = () =>
    [] as unknown as DOMRectList;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../src/components/ui/tooltip");
  const { ControlledMarkdownEditor } = await import("../src/features/editor");
  const { matchesPhysicalShortcut } =
    await import("../src/shared/lib/keyboard-shortcuts");
  const { mockNativeIpc } = await import("../src/platform/native/testing");
  mockNativeIpc(() => null);

  const SOURCE = "First text\n\nSecond [docs](https://example.com) end\n";
  let searches = 0;
  window.addEventListener("keydown", (event) => {
    if (!matchesPhysicalShortcut(event, "KeyK")) return;
    event.preventDefault();
    searches += 1;
  });

  function field() {
    return document.querySelector<HTMLElement>("[data-slate-editor]")!;
  }

  /** The field's texts in order: "First text", "Second ", "docs", " end". */
  function texts() {
    return [...field().querySelectorAll("[data-slate-string]")].map(
      (node) => node.firstChild!,
    );
  }

  /** A shown link popover with the link form (Page / URL). */
  function linkPanelOpen() {
    return [...document.querySelectorAll<HTMLElement>(".bg-popover")].some(
      (popover) =>
        popover.style.display !== "none" &&
        [...popover.querySelectorAll("button")].some(
          (button) => button.textContent === "URL",
        ),
    );
  }

  const layouts = [
    ["en", "k"],
    ["ru", "л"],
  ] as const;

  async function eachPlatform(
    fn: (mac: boolean, key: string) => Promise<void>,
    disabled = false,
  ) {
    for (const mac of [true, false]) {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: mac ? "MacIntel" : "Win32",
      });
      for (const [, key] of layouts) {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        try {
          await act(async () => {
            root.render(
              <TooltipProvider>
                <ControlledMarkdownEditor
                  disabled={disabled}
                  value={SOURCE}
                  onChange={() => {}}
                />
              </TooltipProvider>,
            );
          });
          await settle();
          searches = 0;
          await fn(mac, key);
        } finally {
          await act(async () => root.unmount());
          container.remove();
        }
      }
    }
  }

  test("selected text within one block takes the link panel, not Search", async () => {
    await eachPlatform(async (mac, key) => {
      const [first] = texts();
      await select(first!, 0, first!, "First".length);
      expect(await press(mac, key)).toBe(true);
      expect(linkPanelOpen()).toBe(true);
      expect(searches).toBe(0);
    });
  });

  test("the caret in a link edits the link, not Search", async () => {
    await eachPlatform(async (mac, key) => {
      const link = texts()[2]!;
      await select(link, 2, link, 2);
      expect(linkPanelOpen()).toBe(false);
      expect(await press(mac, key)).toBe(true);
      expect(linkPanelOpen()).toBe(true);
      expect(searches).toBe(0);
    });
  });

  test("a collapsed caret outside a link opens Search without the link panel", async () => {
    await eachPlatform(async (mac, key) => {
      const [first] = texts();
      await select(first!, 3, first!, 3);
      expect(await press(mac, key)).toBe(true);
      expect(searches).toBe(1);
      expect(linkPanelOpen()).toBe(false);
    });
  });

  test("a selection across blocks opens Search without the link panel", async () => {
    await eachPlatform(async (mac, key) => {
      const [first, second] = texts();
      await select(first!, 2, second!, 3);
      expect(await press(mac, key)).toBe(true);
      expect(searches).toBe(1);
      expect(linkPanelOpen()).toBe(false);
    });
  });

  test("a read-only field opens Search without the link panel", async () => {
    await eachPlatform(async (mac, key) => {
      for (const [node, offset] of [
        [texts()[0]!, 0],
        [texts()[2]!, 2],
      ] as const) {
        const before = searches;
        await select(node, offset, node, offset + 2);
        expect(await press(mac, key)).toBe(true);
        expect(searches).toBe(before + 1);
        expect(linkPanelOpen()).toBe(false);
      }
    }, true);
  });

  /** Dispatches ⌘K (Ctrl+K off macOS) at the field; true when it was taken. */
  async function press(mac: boolean, key: string) {
    const event = new window.KeyboardEvent("keydown", {
      code: "KeyK",
      key,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      field().dispatchEvent(event);
    });
    await settle();
    return event.defaultPrevented;
  }

  async function select(
    start: ChildNode,
    startOffset: number,
    end: ChildNode,
    endOffset: number,
  ) {
    await act(async () => field().focus());
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
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
