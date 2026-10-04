import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_TERMINAL_PANEL_TOGGLE_DOM !== "1") {
  test("terminal panel toggle DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TERMINAL_PANEL_TOGGLE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const commands: string[] = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      invoke: async (command: string) => {
        commands.push(command);
        throw new Error(`unexpected command ${command}`);
      },
    },
  });
  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: unknown) => unknown) =>
      selector({
        activeRootId: "root",
        activeRootName: "Project",
        activeRootPath: "/project",
        spaces: [],
      }),
  }));

  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useTerminalStore } = await import("../hooks/use-terminal-store");
  const { TerminalPanelToggle } = await import("./terminal-panel-toggle");
  const { shortcutLabel } = await import("@/shared/lib/shortcut-description");
  const { terminalToggleShortcut } = await import("../model/shortcuts");
  const keys = shortcutLabel(terminalToggleShortcut);

  let mounts = 0;
  let disposals = 0;
  function TerminalContent() {
    const tabs = useTerminalStore((state) => state.tabs);
    return tabs.map((tab) => <TerminalBuffer key={tab.id} />);
  }
  function TerminalBuffer() {
    useEffect(() => {
      mounts += 1;
      return () => {
        disposals += 1;
      };
    }, []);
    return <textarea data-buffer />;
  }

  test("the window header toggle shows and hides the panel without killing the PTY", async () => {
    useTerminalStore.setState({
      panelOpen: false,
      tabs: [
        {
          id: "tab",
          title: "Project",
          scope: "project",
          scopeId: "root",
          cwd: "/project",
          ptyId: "pty",
          status: "ready",
          error: null,
          createdAt: "2026-09-26T00:00:00.000Z",
        },
      ],
      activeTabId: "tab",
    });
    const root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <TerminalPanelToggle />
          <TerminalContent />
        </TooltipProvider>,
      ),
    );
    const action = () =>
      document.querySelector<HTMLButtonElement>("[aria-keyshortcuts]")!;
    const buffer = document.querySelector("[data-buffer]");

    expect(action().getAttribute("aria-label")).toBe(`Show terminal (${keys})`);
    expect(action().getAttribute("aria-pressed")).toBe("false");
    expect(action().getAttribute("aria-keyshortcuts")).toBe("Control+`");

    await act(async () => action().click());
    expect(useTerminalStore.getState().panelOpen).toBe(true);
    expect(action().getAttribute("aria-label")).toBe(`Hide terminal (${keys})`);
    expect(action().getAttribute("aria-pressed")).toBe("true");

    await act(async () => action().click());
    expect(useTerminalStore.getState().panelOpen).toBe(false);
    expect(useTerminalStore.getState().tabs[0]?.ptyId).toBe("pty");
    expect(document.querySelector("[data-buffer]")).toBe(buffer);
    expect(mounts).toBe(1);
    expect(disposals).toBe(0);
    expect(commands.includes("terminal_kill")).toBe(false);
    expect(commands.includes("terminal_spawn")).toBe(false);

    await act(async () => root.unmount());
    dom.window.close();
  });
}
