import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
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
    '<div id="app"></div><input id="input"><div class="xterm"><textarea></textarea></div>',
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const calls = { palette: 0, home: 0, navigate: 0, guard: 0, create: 0 };
  let allowNavigation = true;
  let activeRootPath: string | null = "/project";
  mock.module("@tanstack/react-router", () => ({
    useNavigate: () => () => calls.navigate++,
  }));
  mock.module("@/features/actors", () => ({
    requestActorMailmapSave() {},
    requestAgentActorCatalogSave() {},
  }));
  mock.module("@/features/artifact", () => ({
    useActiveContentPath: () => "page.md",
    useActiveContentSpaceId: () => null,
    useCloseActiveContent: () => () => {},
  }));
  mock.module("@/features/git/app-shell", () => ({
    commitSaveScopeAndMaybeSync() {},
    dirtyPathsForGitSaveScope: () => [],
    getGitSpaceStatus() {},
    gitSaveShortcutLabel: () => "",
  }));
  mock.module("@/features/git", () => ({
    repositoryAccessIsEditable: () => true,
    useRepositoryAccess: () => ({}),
  }));
  mock.module("@/features/search/app-shell", () => ({
    useToggleCommandPalette: () => () => calls.palette++,
  }));
  mock.module("@/features/space", () => ({
    useSpace: (selector: (state: unknown) => unknown) =>
      selector({
        activeRootPath,
        activeRootId: null,
        goHome: () => calls.home++,
      }),
  }));
  mock.module("@/features/scope-surfaces", () => ({
    useScopeSurfaceStore: (selector: (state: unknown) => unknown) =>
      selector({}),
  }));
  mock.module("../model", () => ({
    useShellStore: () => ({ openAppSettings() {}, toggleChatPanel() {} }),
  }));
  mock.module("@/features/collection/app-shell", () => ({
    useCollectionDetailController: () => null,
    runCollectionNavigation: (_: unknown, action: () => void) => {
      calls.guard++;
      if (allowNavigation) action();
    },
  }));
  mock.module("@/features/collection", () => ({
    useCollectionActivePresentationId: () => null,
  }));
  mock.module("@/features/branding", () => ({
    ProjectLoadingLogo: () => null,
  }));
  mock.module("@/features/settings", () => ({ useAppVersion: () => "test" }));
  mock.module("@/features/home/ui/project-list", () => ({
    ProjectList: () => null,
  }));
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
  const { HomePage } = await import("@/features/home");
  function Shell() {
    useKeyboardShortcuts();
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
            <HomePage />
          </>,
        );
      });
      for (const [code, key, field, extra] of [
        ["KeyP", "З", "palette", {}],
        ["KeyN", "Т", "create", {}],
        ["KeyO", "Щ", "home", { shiftKey: true }],
      ] as const) {
        const before = calls[field];
        await act(async () => {
          expect(fire(code, key, mac, extra).defaultPrevented).toBe(true);
        });
        expect(calls[field]).toBe(before + 1);
        for (const patch of [
          { altKey: true },
          { isComposing: true },
          { shiftKey: code !== "KeyO" },
          { metaKey: true, ctrlKey: true },
        ]) {
          await act(async () => {
            fire(code, key, mac, { ...extra, ...patch });
          });
          expect(calls[field]).toBe(before + 1);
        }
        await act(async () => {
          fire(code, key, mac, extra, document.querySelector("textarea")!);
        });
        expect(calls[field]).toBe(before + 1);
      }
      const before = calls.home;
      allowNavigation = false;
      await act(async () => {
        fire("KeyO", "O", mac, { shiftKey: true });
      });
      expect(calls.home).toBe(before);
      allowNavigation = true;
      const palette = calls.palette;
      activeRootPath = null;
      await act(async () => {
        root.render(<Shell />);
      });
      await act(async () => {
        fire("KeyP", "p", mac);
      });
      expect(calls.palette).toBe(palette);
      activeRootPath = "/project";
    }
    expect(calls.guard).toBe(4);
    expect(calls.navigate).toBe(2);
    await act(async () => root.unmount());
    dom.window.close();
  });
}
