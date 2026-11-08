import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

if (process.env.SVODE_ATTACHMENT_BADGE_DOM !== "1") {
  test("attachment badge DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ATTACHMENT_BADGE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");
  const { mockNativeIpc } = await import("@/platform/native/testing");
  const { AttachmentOpenerContext } =
    await import("../hooks/use-attachment-opener");
  const { AttachmentBadge } = await import("./attachment-badge");

  const files = new Set(["/work/project/notes.txt"]);
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as { path?: string };
    if (command === "path_exists") return files.has(payload.path!);
    throw new Error(`Unexpected command: ${command}`);
  });

  const doc = dom.window.document;
  const opened: string[] = [];

  async function render(path: string, onOpen?: () => void) {
    const root = createRoot(doc.getElementById("app")!);
    await act(async () => {
      root.render(
        <AttachmentOpenerContext.Provider
          value={(attachment) => opened.push(attachment.path)}
        >
          <AttachmentBadge
            attachment={{ path, name: path.split("/").pop()! }}
            onOpen={onOpen}
          />
        </AttachmentOpenerContext.Provider>,
      );
    });
    await settle();
    return root;
  }

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  /** Past the open delay of the hover card. */
  async function pastDelay() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();
  }

  function badge(): HTMLButtonElement {
    return doc.querySelector<HTMLButtonElement>(
      '[data-slot="hover-card-trigger"]',
    )!;
  }

  function cardOpen(): boolean {
    return doc.querySelector('[data-slot="hover-card-content"]') !== null;
  }

  async function dispatch(event: Event) {
    await act(async () => {
      badge().dispatchEvent(event);
    });
  }

  const pointerEnter = () =>
    dispatch(new dom.window.MouseEvent("pointerover", { bubbles: true }));
  const pointerLeave = () =>
    dispatch(new dom.window.MouseEvent("pointerout", { bubbles: true }));
  const click = () =>
    dispatch(new dom.window.MouseEvent("click", { bubbles: true }));
  const focus = () =>
    act(async () => {
      badge().focus();
    });
  const blur = () =>
    act(async () => {
      badge().blur();
    });
  /** Enter on a focused button: the browser clicks it. */
  const pressEnter = async () => {
    await dispatch(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await dispatch(
      new dom.window.MouseEvent("click", { bubbles: true, detail: 0 }),
    );
  };

  test("a click on a hovered badge closes its hover card, which stays shut while the pointer rests", async () => {
    opened.length = 0;
    const root = await render("/work/project/notes.txt");

    await pointerEnter();
    await pastDelay();
    expect(cardOpen()).toBe(true);

    await click();
    await settle();
    expect(opened).toEqual(["/work/project/notes.txt"]);
    expect(cardOpen()).toBe(false);

    await pastDelay();
    expect(cardOpen()).toBe(false);

    // The pointer leaves; the next hover shows the card again.
    await pointerLeave();
    await pastDelay();
    await pointerEnter();
    await pastDelay();
    expect(cardOpen()).toBe(true);

    await act(async () => root.unmount());
  });

  test("a click before the delay cancels the pending open, and the focus a click gives does not reopen it", async () => {
    opened.length = 0;
    const root = await render("/work/project/notes.txt");

    await pointerEnter();
    await click();
    await pastDelay();
    expect(opened).toEqual(["/work/project/notes.txt"]);
    expect(cardOpen()).toBe(false);

    // A click focuses the button in Chromium (WebView2).
    await focus();
    await pastDelay();
    expect(cardOpen()).toBe(false);

    // Focus is still on the badge: leaving with the pointer is not enough.
    await pointerLeave();
    await pastDelay();
    await pointerEnter();
    await pastDelay();
    expect(cardOpen()).toBe(false);

    await pointerLeave();
    await blur();
    await pastDelay();
    await pointerEnter();
    await pastDelay();
    expect(cardOpen()).toBe(true);

    await act(async () => root.unmount());
  });

  test("Enter on a focused badge closes its hover card, which stays shut while focus stays on the badge", async () => {
    opened.length = 0;
    let ownerOpened = 0;
    const root = await render("/work/project/notes.txt", () => {
      ownerOpened += 1;
    });

    await focus();
    await pastDelay();
    expect(cardOpen()).toBe(true);

    await pressEnter();
    await settle();
    expect(ownerOpened).toBe(1);
    expect(opened).toEqual([]);
    expect(cardOpen()).toBe(false);

    await pastDelay();
    expect(cardOpen()).toBe(false);

    await blur();
    await pastDelay();
    await focus();
    await pastDelay();
    expect(cardOpen()).toBe(true);

    await act(async () => root.unmount());
  });

  test("a click on the badge of a missing file opens nothing and leaves its hover card open", async () => {
    opened.length = 0;
    const root = await render("/work/project/gone.txt");

    await pointerEnter();
    await pastDelay();
    expect(cardOpen()).toBe(true);

    await click();
    await pastDelay();
    expect(opened).toEqual([]);
    expect(cardOpen()).toBe(true);

    await act(async () => root.unmount());
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}
