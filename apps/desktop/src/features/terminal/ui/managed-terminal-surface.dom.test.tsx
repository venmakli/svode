import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

// Module mocks stay in this process, so the scenarios run in a child one.
if (process.env.SVODE_MANAGED_TERMINAL_DOM !== "1") {
  test("managed terminal surface DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_MANAGED_TERMINAL_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  // xterm reads the device pixel ratio through matchMedia when it opens.
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    KeyboardEvent: dom.window.KeyboardEvent,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  /** Everything the views wrote to PTY input, in order. */
  const ptyInput: Array<{ ptyId: string; data: string }> = [];
  const noListener = async () => () => {};
  mock.module("@/features/terminal/api/terminal", () => ({
    spawnTerminal: async () => ({ ptyId: "spawned", cwd: "/" }),
    writeTerminal: async (ptyId: string, data: string) => {
      ptyInput.push({ ptyId, data });
    },
    resizeTerminal: async () => {},
    killTerminal: async () => {},
    listTerminals: async () => [],
    prepareTerminalPaths: async () => "",
    prepareTerminalResourcePaths: async () => "",
    registerAgentTerminalSession: async () => {},
    onTerminalOutput: noListener,
    onTerminalExit: noListener,
    onTerminalError: noListener,
  }));

  const { ManagedTerminalSurface } = await import("./managed-terminal-surface");
  const { clearTerminalOutput, publishTerminalOutput } =
    await import("@/features/terminal/lib/output-bus");

  const TERMINAL_REQUESTS = "\x1b[c\x1b[6n\x1b]11;?\x07";
  const DA1_ANSWER = "\x1b[?1;2c";

  const inputOf = (ptyId: string) =>
    ptyInput.filter((entry) => entry.ptyId === ptyId).map(({ data }) => data);

  /** Lets xterm parse queued writes, which it does on timers. */
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  async function mountView(ptyId: string) {
    const host = dom.window.document.createElement("div");
    dom.window.document.getElementById("app")!.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ManagedTerminalSurface ptyId={ptyId} autoFocus={false} />);
    });
    await settle();
    return { host, root };
  }

  async function unmountView({
    host,
    root,
  }: {
    host: HTMLElement;
    root: Root;
  }) {
    await act(async () => root.unmount());
    host.remove();
  }

  /** Types one printable character into the view, as a keyboard does. */
  async function typeInto(host: HTMLElement, char: string) {
    const textarea = host.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    )!;
    await act(async () => {
      textarea.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: char,
          keyCode: char.toUpperCase().charCodeAt(0),
          bubbles: true,
        }),
      );
    });
  }

  test("showing a terminal again does not answer replayed requests", async () => {
    const ptyId = "replayed-requests";
    publishTerminalOutput(ptyId, "agent prompt ");
    publishTerminalOutput(ptyId, TERMINAL_REQUESTS);

    const view = await mountView(ptyId);
    expect(view.host.textContent?.includes("agent prompt")).toBe(true);
    expect(inputOf(ptyId)).toEqual([]);

    // A request the program sends while the terminal is shown is answered.
    await act(async () => publishTerminalOutput(ptyId, "\x1b[c"));
    await settle();
    expect(inputOf(ptyId)).toEqual([DA1_ANSWER]);

    await typeInto(view.host, "x");
    expect(inputOf(ptyId)).toEqual([DA1_ANSWER, "x"]);

    await unmountView(view);
    clearTerminalOutput(ptyId);
  });

  test("only the last shown view of a PTY writes its input", async () => {
    const ptyId = "two-views";
    publishTerminalOutput(ptyId, TERMINAL_REQUESTS);

    const leaving = await mountView(ptyId);
    const arriving = await mountView(ptyId);
    expect(inputOf(ptyId)).toEqual([]);

    await act(async () => publishTerminalOutput(ptyId, "\x1b[c"));
    await settle();
    expect(inputOf(ptyId)).toEqual([DA1_ANSWER]);

    await typeInto(leaving.host, "a");
    await typeInto(arriving.host, "b");
    expect(inputOf(ptyId)).toEqual([DA1_ANSWER, "b"]);

    await unmountView(arriving);
    await typeInto(leaving.host, "c");
    expect(inputOf(ptyId)).toEqual([DA1_ANSWER, "b", "c"]);

    await unmountView(leaving);
    clearTerminalOutput(ptyId);
  });
}
