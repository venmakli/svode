import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_OPEN_SESSION_MAIN_DOM !== "1") {
  test("open session in the main area DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_OPEN_SESSION_MAIN_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
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

  mock.module("./navigation-guards", () => ({
    passNavigationGuards: async () => true,
  }));
  const spaceState = {
    openSpace: async () => undefined,
    clearActiveSpace: () => undefined,
  };
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (selector: (state: typeof spaceState) => unknown) =>
      selector(spaceState),
  }));

  const { useShellStore } = await import("./model");
  const { useOpenSessionInMainArea } = await import("./agent-session-peek-host");
  const target = { sessionId: "codex:a", launchId: null };
  let open: ReturnType<typeof useOpenSessionInMainArea> | null = null;
  function Opener() {
    const handle = useOpenSessionInMainArea();
    useEffect(() => {
      open = handle;
    }, [handle]);
    return null;
  }
  const root = createRoot(document.getElementById("app")!);
  await act(async () => root.render(<Opener />));

  test("a sidebar row asks for the composer and keeps the main area from taking focus", async () => {
    // Enter on the row: the row holds focus.
    const row = document.createElement("button");
    document.body.append(row);
    row.focus();
    await act(async () => {
      await open!(target, null, { focus: "composer" });
    });
    let state = useShellStore.getState();
    expect(state.mainSessionTarget?.sessionId).toBe("codex:a");
    expect(state.mainSessionFocus).toBe(false);
    expect(state.mainSessionComposerFocus?.opener === row).toBe(true);

    // A click in WKWebView leaves focus nowhere: a new request, its own opener.
    row.blur();
    const before = state.mainSessionComposerFocus;
    await act(async () => {
      await open!(target, null, { focus: "composer" });
    });
    state = useShellStore.getState();
    expect(state.mainSessionComposerFocus !== before).toBe(true);
    expect(state.mainSessionComposerFocus?.opener ?? null).toBeNull();
  });

  test("Expand moves focus into the main area without the composer's request", async () => {
    await act(async () => {
      await open!(target, null);
    });
    const state = useShellStore.getState();
    expect(state.mainSessionFocus).toBe(true);
    expect(state.mainSessionComposerFocus).toBeNull();
  });
}
