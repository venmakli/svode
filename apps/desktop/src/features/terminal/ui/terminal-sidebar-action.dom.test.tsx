import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_TERMINAL_SIDEBAR_DOM !== "1") {
  test("terminal sidebar action DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TERMINAL_SIDEBAR_DOM: "1" },
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
        if (command === "terminal_list_agent_surfaces") return [];
        if (command === "agent_sessions_list") return { sessions: [] };
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

  const { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } =
    await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useTerminalStore } = await import("../hooks/use-terminal-store");
  const { TerminalSidebarAction } = await import("./terminal-sidebar-action");

  let sessionsOpens = 0;
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

  test("sessions row action toggles the drawer without changing the surface or killing the PTY", async () => {
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
          origin: "shell",
          createdAt: "2026-09-26T00:00:00.000Z",
        },
      ],
      activeTabId: "tab",
    });
    const root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => sessionsOpens++}>
                  Sessions
                </SidebarMenuButton>
                <TerminalSidebarAction />
              </SidebarMenuItem>
            </SidebarMenu>
            <TerminalContent />
          </SidebarProvider>
        </TooltipProvider>,
      ),
    );
    const action = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-sidebar="menu-action"]',
      )!;
    const buffer = document.querySelector("[data-buffer]");

    expect(action().getAttribute("aria-label")).toBe("Show terminal");
    expect(action().getAttribute("aria-pressed")).toBe("false");
    expect(action().className.includes("md:opacity-0")).toBe(true);
    expect(action().getAttribute("aria-keyshortcuts")).toBe("Control+`");

    await act(async () => action().click());
    expect(useTerminalStore.getState().panelOpen).toBe(true);
    expect(action().getAttribute("aria-label")).toBe("Hide terminal");
    expect(action().getAttribute("aria-pressed")).toBe("true");
    expect(action().className.includes("md:opacity-100")).toBe(true);

    await act(async () => action().click());
    expect(useTerminalStore.getState().panelOpen).toBe(false);
    expect(useTerminalStore.getState().tabs[0]?.ptyId).toBe("pty");
    expect(document.querySelector("[data-buffer]")).toBe(buffer);
    expect(mounts).toBe(1);
    expect(disposals).toBe(0);
    expect(sessionsOpens).toBe(0);
    expect(commands.includes("terminal_kill")).toBe(false);
    expect(commands.includes("terminal_spawn")).toBe(false);

    await act(async () => root.unmount());
    dom.window.close();
  });
}
