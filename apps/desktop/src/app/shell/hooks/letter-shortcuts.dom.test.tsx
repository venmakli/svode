import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_LETTER_DOM !== "1") {
  test("app and Home letter shortcuts DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_LETTER_DOM: "1" },
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
  const dom = new JSDOM(
    '<div id="app"></div><input id="input"><div class="xterm"><textarea></textarea></div><div data-agent-session-content><div class="xterm"><textarea id="session-terminal"></textarea></div></div>',
    { url: "http://localhost/" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const calls = {
    search: 0,
    home: 0,
    navigate: 0,
    guard: 0,
    create: 0,
    close: 0,
  };
  const commands: string[] = [];
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    value: {
      invoke: async (command: string) => {
        commands.push(command);
        if (command === "terminal_spawn")
          return { ptyId: "pty", cwd: "/project", shell: "sh", cols: 80 };
        throw new Error(`unexpected command ${command}`);
      },
    },
  });
  let allowNavigation = true;
  let activeRootPath: string | null = "/project";
  mock.module("@tanstack/react-router", () => ({
    useNavigate: () => () => calls.navigate++,
  }));
  const actors = { ...(await import("@/features/actors")) };
  mock.module("@/features/actors", () => ({
    ...actors,
    requestActorMailmapSave() {},
    requestAgentActorCatalogSave() {},
  }));
  const artifact = { ...(await import("@/features/artifact")) };
  mock.module("@/features/artifact", () => ({
    ...artifact,
    useActiveContentPath: () => "page.md",
    useActiveContentSpaceId: () => null,
    useCloseActiveContent: () => () => {},
  }));
  const gitAppShell = { ...(await import("@/features/git/app-shell")) };
  mock.module("@/features/git/app-shell", () => ({
    ...gitAppShell,
    commitSaveScopeAndMaybeSync() {},
    dirtyPathsForGitSaveScope: () => [],
    getGitSpaceStatus() {},
    gitSaveShortcutLabel: () => "",
  }));
  const git = { ...(await import("@/features/git")) };
  mock.module("@/features/git", () => ({
    ...git,
    repositoryAccessIsEditable: () => true,
    useRepositoryAccess: () => ({}),
  }));
  const searchAppShell = { ...(await import("@/features/search/app-shell")) };
  mock.module("@/features/search/app-shell", () => ({
    ...searchAppShell,
    useToggleCommandPalette: () => () => calls.search++,
  }));
  const space = { ...(await import("@/features/space")) };
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector: (state: unknown) => unknown) =>
      selector({
        activeRootPath,
        activeRootId: activeRootPath ? "root" : null,
        activeRootName: "Project",
        rootSpaces: [],
        spaces: [],
        goHome: () => calls.home++,
      }),
  }));
  const scopeSurfaces = { ...(await import("@/features/scope-surfaces")) };
  mock.module("@/features/scope-surfaces", () => ({
    ...scopeSurfaces,
    useScopeSurfaceStore: (selector: (state: unknown) => unknown) =>
      selector({}),
  }));
  mock.module("../model", () => ({
    useShellStore: () => ({ openAppSettings() {} }),
  }));
  mock.module("../agent-session-peek-host", () => ({
    useStartSessionInMainArea: () => async () => {},
  }));
  mock.module("../navigation-guards", () => ({
    passNavigationGuards: async () => {
      calls.guard++;
      return allowNavigation;
    },
  }));
  mock.module("../working-set", () => ({
    useWorkingSetActions: () => ({
      closeMainAreaObject: async () => {
        calls.close++;
      },
    }),
  }));
  const agentSessions = { ...(await import("@/features/agent-sessions")) };
  mock.module("@/features/agent-sessions", () => ({
    ...agentSessions,
    isInsideAgentSessionContent: (target: EventTarget | null) =>
      target instanceof dom.window.Element &&
      target.closest("[data-agent-session-content]") !== null,
  }));
  const collection = { ...(await import("@/features/collection")) };
  mock.module("@/features/collection", () => ({
    ...collection,
    useCollectionActivePresentationId: () => null,
  }));
  mock.module("@/features/branding", () => ({
    ProjectLoadingLogo: () => null,
  }));
  mock.module("@/features/settings", () => ({ useAppVersion: () => "test" }));
  mock.module("@/features/home/ui/empty-state", () => ({
    EmptyState: () => null,
  }));
  mock.module("@/features/home/ui/root-project-dialogs", () => ({
    RootProjectDialogs: () => null,
  }));
  mock.module("@/features/home/hooks/use-root-project-window-title", () => ({
    useRootProjectWindowTitle() {},
  }));
  mock.module("@/features/home/hooks/use-root-project-workflow", () => ({
    useRootProjectWorkflow: () => ({
      explicitHome: true,
      initializeHome: async () => false,
      rootSpaces: [],
      setCreateDialogOpen: () => calls.create++,
    }),
  }));
  const { useKeyboardShortcuts } = await import("./use-keyboard-shortcuts");
  const { EmptyHome } = await import("@/features/home");
  const { ShellViewContext } = await import("../shell-view");
  const { useTerminalPanelToggle } = await import("@/features/terminal");
  let terminalOpen = false;
  function Shell() {
    useKeyboardShortcuts();
    const { panelOpen } = useTerminalPanelToggle();
    useEffect(() => {
      terminalOpen = panelOpen;
    }, [panelOpen]);
    return null;
  }
  const root = createRoot(document.getElementById("app")!);
  const fire = (
    code: string,
    key: string,
    mac: boolean,
    extra: KeyboardEventInit = {},
    target: Element | Window = window,
  ) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      code,
      key,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    target.dispatchEvent(event);
    return event;
  };
  test("physical layout, modifiers, terminal boundary and guarded navigation", async () => {
    for (const mac of [true, false]) {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: mac ? "MacIntel" : "Win32",
      });
      await act(async () => {
        root.render(
          <>
            <Shell />
            <EmptyHome />
          </>,
        );
      });
      for (const [code, key, field] of [
        ["KeyK", "k", "search"],
        ["KeyK", "л", "search"],
        ["KeyN", "Т", "create"],
        ["Digit0", "0", "home"],
      ] as const) {
        const before = calls[field];
        await act(async () => {
          expect(fire(code, key, mac).defaultPrevented).toBe(true);
        });
        expect(calls[field]).toBe(before + 1);
        for (const patch of [
          { altKey: true },
          { isComposing: true },
          { shiftKey: true },
          { metaKey: true, ctrlKey: true },
        ]) {
          await act(async () => {
            fire(code, key, mac, patch);
          });
          expect(calls[field]).toBe(before + 1);
        }
        if (code === "Digit0") continue;
        await act(async () => {
          fire(code, key, mac, {}, document.querySelector("textarea")!);
        });
        expect(calls[field]).toBe(before + 1);
      }
      // ⌘P / Ctrl+P no longer opens Search, in any layout.
      for (const key of ["p", "з"]) {
        const search = calls.search;
        await act(async () => {
          expect(fire("KeyP", key, mac).defaultPrevented).toBe(false);
        });
        expect(calls.search).toBe(search);
      }
      // ⌘0 goes Home from a terminal on macOS; Ctrl+0 stays with the shell.
      const home = calls.home;
      await act(async () => {
        fire("Digit0", "0", mac, {}, document.querySelector("textarea")!);
      });
      expect(calls.home).toBe(mac ? home + 1 : home);
      // The former hidden ⌘⇧O does nothing.
      await act(async () => {
        expect(
          fire("KeyO", "O", mac, { shiftKey: true }).defaultPrevented,
        ).toBe(false);
      });
      expect(calls.home).toBe(mac ? home + 1 : home);
      const before = calls.home;
      allowNavigation = false;
      await act(async () => {
        fire("Digit0", "à", mac);
      });
      expect(calls.home).toBe(before);
      allowNavigation = true;
      // Home alone takes no ⌘0.
      await act(async () => {
        root.render(<EmptyHome />);
      });
      await act(async () => {
        expect(fire("Digit0", "0", mac).defaultPrevented).toBe(false);
      });
      expect(calls.home).toBe(before);
      const search = calls.search;
      activeRootPath = null;
      await act(async () => {
        root.render(<Shell />);
      });
      await act(async () => {
        fire("KeyK", "k", mac);
      });
      expect(calls.search).toBe(search);
      activeRootPath = "/project";
    }
    expect(calls.guard).toBe(5);
    expect(calls.navigate).toBe(3);
  });
  test("the Home shell takes no Search, terminal panel or ⌘0", async () => {
    for (const mac of [true, false]) {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: mac ? "MacIntel" : "Win32",
      });
      await act(async () => {
        root.render(
          <ShellViewContext.Provider value="home">
            <Shell />
          </ShellViewContext.Provider>,
        );
      });
      const { search, home, guard } = calls;
      const panel = terminalOpen;
      await act(async () => {
        fire("KeyK", "k", mac);
        expect(
          fire("Backquote", "`", false, { ctrlKey: true }).defaultPrevented,
        ).toBe(false);
        fire("Digit0", "0", mac);
      });
      expect(calls.search).toBe(search);
      expect(terminalOpen).toBe(panel);
      expect(calls.home).toBe(home);
      expect(calls.guard).toBe(guard);
    }
  });
  test("⌘W closes the main area object by its physical key, in session terminals only as Cmd", async () => {
    for (const mac of [true, false]) {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: mac ? "MacIntel" : "Win32",
      });
      await act(async () => {
        root.render(<Shell />);
      });
      const before = calls.close;
      await act(async () => {
        expect(fire("KeyW", "ц", mac).defaultPrevented).toBe(true);
      });
      expect(calls.close).toBe(before + 1);
      // The terminal panel takes no ⌘W; Ctrl+W stays with the shell.
      await act(async () => {
        expect(
          fire("KeyW", "w", mac, {}, document.querySelector(".xterm textarea")!)
            .defaultPrevented,
        ).toBe(mac);
      });
      await act(async () => {
        expect(
          fire(
            "KeyW",
            "w",
            mac,
            {},
            document.getElementById("session-terminal")!,
          ).defaultPrevented,
        ).toBe(mac);
      });
      expect(calls.close).toBe(before + (mac ? 2 : 1));
    }
  });
  test("Ctrl+` toggles the terminal from any focus without taking other keys", async () => {
    const toggle = (extra: KeyboardEventInit = {}, target?: Element) =>
      fire("Backquote", "`", false, { ctrlKey: true, ...extra }, target);
    for (const mac of [true, false]) {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: mac ? "MacIntel" : "Win32",
      });
      await act(async () => {
        root.render(<Shell />);
      });
      for (const target of [
        undefined,
        document.getElementById("input")!,
        document.querySelector(".xterm textarea")!,
      ]) {
        const before = terminalOpen;
        await act(async () => {
          expect(toggle({}, target).defaultPrevented).toBe(true);
        });
        expect(terminalOpen).toBe(!before);
      }
      const before = terminalOpen;
      for (const patch of [
        { shiftKey: true },
        { altKey: true },
        { metaKey: true },
        { ctrlKey: false, metaKey: true },
        { isComposing: true },
        { code: "KeyC", key: "c" },
      ]) {
        await act(async () => {
          toggle(patch, document.querySelector(".xterm textarea")!);
        });
        expect(terminalOpen).toBe(before);
      }
      activeRootPath = null;
      await act(async () => {
        root.render(<Shell />);
      });
      await act(async () => {
        expect(toggle().defaultPrevented).toBe(false);
      });
      expect(terminalOpen).toBe(before);
      activeRootPath = "/project";
    }
    expect(commands.includes("terminal_kill")).toBe(false);
    await act(async () => root.unmount());
    dom.window.close();
  });
}
