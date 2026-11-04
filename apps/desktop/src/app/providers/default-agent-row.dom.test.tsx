import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

// "Default agent" of the settings window, rendered through the app
// composition with its own tooltip provider and none of the test's.
if (process.env.SVODE_DEFAULT_AGENT_ROW_DOM !== "1") {
  test("default agent row DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_DEFAULT_AGENT_ROW_DOM: "1" },
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
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  // cmdk keeps the selected item in view.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { createRoot } = await import("react-dom/client");

  // The sidebar of the settings window asks for the viewport width.
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const spaceState: {
    activeRootPath: string | null;
    spaces: { path: string }[];
  } = {
    activeRootPath: "/project",
    spaces: [],
  };
  const space = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...space,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  const agents = [
    { agent: "codex", name: "Codex" },
    { agent: "claude-code", name: "Claude Code" },
    { agent: "custom-mine", name: "Mine" },
  ];
  const draftKey = { agent: "codex", namespace: "native", sessionId: "d1" };
  /** Calls of the commands, with their arguments. */
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  const channels = new Map<string, { id: number; index: number }>();
  let stored: unknown = null;
  let declarationsAnswer: () => unknown = () => [];

  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, payload });
    switch (command) {
      case "git_check_availability":
        return {
          git: true,
          gitLfs: false,
          gitVersion: "2.51.0",
          gitLfsVersion: null,
          gitVersionSupported: true,
          gitMinimumVersion: "2.31.0",
        };
      case "get_git_identity":
        return {
          global: { name: "Alice", email: "alice@example.test" },
          source: "global",
          fingerprint: "v1",
        };
      case "get_app_preferences":
        return { language: "en", theme: "light", themeNeedsRecovery: false };
      case "agent_setup_list":
        return agents.slice(0, 2).map(({ agent }) => agentSetup(agent));
      case "agent_custom_list":
      case "speech_dictated_texts":
      case "speech_model_licenses":
        return [];
      case "plugin:app|version":
        return "0.0.9";
      case "mcp_get_status":
        return mcpStatus();
      case "agent_adapters_list_identities":
        return agents.map(({ agent, name }) => ({
          id: agent,
          displayName: name,
        }));
      case "agent_default_get":
        return stored;
      case "agent_default_set":
        stored = payload.defaultAgent;
        return null;
      case "agent_setup_chat_agents":
        return {
          agents: agents.map((agent) => ({
            ...agent,
            offer: { state: "available" },
          })),
        };
      case "agent_runtime_hold_draft":
        return {
          hold: 5,
          check: {
            state: "ready",
            agent: { name: "codex-acp", version: "2.1.1" },
          },
          session: draftKey,
          keepsValuesUntilSend: false,
        };
      case "agent_runtime_last_declarations":
        return declarationsAnswer();
      case "agent_runtime_subscribe": {
        const channel = payload.channel as { id: number };
        const session = payload.session as typeof draftKey;
        channels.set(session.sessionId, { id: channel.id, index: 1 });
        setTimeout(() =>
          runCallback(channel.id, {
            index: 0,
            message: { type: "snapshot", value: snapshot(session) },
          }),
        );
        return 1;
      }
      case "agent_runtime_set_setting":
      case "agent_runtime_unsubscribe":
      case "agent_runtime_release_draft":
        return null;
    }
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { useShellStore } = await import("@/app/shell/model");
  const { AppProviders } = await import("./app-providers");
  const {
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRouter,
  } = await import("@tanstack/react-router");

  const mounted: Root[] = [];
  function rowTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      calls.length = 0;
      channels.clear();
      stored = null;
      declarationsAnswer = () => [];
      spaceState.activeRootPath = "/project";
      try {
        await fn();
      } finally {
        await act(async () => useShellStore.getState().closeSettings());
        for (const root of mounted.splice(0)) {
          await act(async () => root.unmount());
        }
        document.body.innerHTML = "";
      }
    });
  }

  rowTest(
    "a chosen agent and value are stored at once while the popover stays open, and the agent's draft session runs in the project root until it closes",
    async () => {
      await mount();
      expect(trigger().textContent).toBe(m.settings_default_agent_none());
      // Nothing about the agents is read before the popover opens.
      expect(
        calls.some((call) => call.command === "agent_setup_chat_agents"),
      ).toBe(false);

      await click(trigger());
      // The agents the chat offers, a custom one included.
      expect(agentTabs().length).toBe(3);
      await click(agentTabs()[0]);
      expect(lastCall("agent_default_set")).toEqual({
        defaultAgent: { agent: "codex", settings: [] },
      });
      expect(popover() !== null).toBe(true);
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/project",
      });
      // The mode is the last row under the agent's own label.
      expect(rowLabels()).toEqual([
        m.sessions_chat_model(),
        m.sessions_chat_reasoning_level(),
        "Collaboration mode",
        "Mode",
      ]);

      await chooseValue(m.sessions_chat_model(), "GPT-6 Sol");
      expect(lastCall("agent_runtime_set_setting")).toEqual({
        session: draftKey,
        value: { setting: "model", value: "gpt-6-sol" },
      });
      expect(lastCall("agent_default_set")).toEqual({
        defaultAgent: {
          agent: "codex",
          settings: [{ setting: "model", value: "gpt-6-sol" }],
        },
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol" }),
      });
      await chooseValue("Mode", "Auto review");
      expect(lastCall("agent_default_set")).toEqual({
        defaultAgent: {
          agent: "codex",
          settings: [
            { setting: "model", value: "gpt-6-sol" },
            { setting: "mode", value: "agent" },
          ],
        },
      });
      expect(popover() !== null).toBe(true);
      expect(lastCall("agent_runtime_release_draft")).toBe(undefined);

      await act(async () => {
        document.activeElement?.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
      });
      await settle();
      expect(popover()).toBe(null);
      expect(lastCall("agent_runtime_release_draft")).toEqual({ hold: 5 });
      // The entry keeps naming the chosen model.
      expect(trigger().textContent?.includes("GPT-6 Sol")).toBe(true);
      expect(trigger().getAttribute("aria-label")).toBe(
        m.settings_default_agent_button({ agent: "Codex, GPT-6 Sol, Low" }),
      );
    },
  );

  rowTest(
    "the stored values apply to the draft session of the opened popover",
    async () => {
      stored = {
        agent: "codex",
        settings: [
          { setting: "model", value: "gpt-6-sol" },
          { setting: "mode", value: "agent" },
        ],
      };
      await mount();
      await click(trigger());
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/project",
      });
      expect(
        calls
          .filter((call) => call.command === "agent_runtime_set_setting")
          .map((call) => call.payload.value),
      ).toEqual([
        { setting: "model", value: "gpt-6-sol" },
        { setting: "mode", value: "agent" },
      ]);
      expect(calls.some((call) => call.command === "agent_default_set")).toBe(
        false,
      );
    },
  );

  rowTest(
    "a stored value the agent no longer offers shows in its row with a note and stays stored until a new choice writes",
    async () => {
      stored = {
        agent: "codex",
        settings: [
          { setting: "model", value: "gpt-4-old" },
          { setting: "mode", value: "agent" },
          { setting: "legacy_toggle", value: "on" },
        ],
      };
      await mount();
      await click(trigger());
      // Only the values the agent offers apply; nothing is written.
      expect(
        calls
          .filter((call) => call.command === "agent_runtime_set_setting")
          .map((call) => call.payload.value),
      ).toEqual([{ setting: "mode", value: "agent" }]);
      expect(calls.some((call) => call.command === "agent_default_set")).toBe(
        false,
      );
      expect(rowValue(m.sessions_chat_model())).toBe("gpt-4-old");
      expect(rowValue("legacy_toggle")).toBe("on");
      expect(staleNotes()).toBe(2);
      expect(trigger().textContent?.includes("gpt-4-old")).toBe(true);

      await chooseValue(m.sessions_chat_model(), "GPT-6 Sol");
      expect(lastCall("agent_default_set")).toEqual({
        defaultAgent: {
          agent: "codex",
          settings: [
            { setting: "mode", value: "agent" },
            { setting: "legacy_toggle", value: "on" },
            { setting: "model", value: "gpt-6-sol" },
          ],
        },
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol" }),
      });
      expect(rowValue(m.sessions_chat_model())).toBe("GPT-6 Sol");
      expect(staleNotes()).toBe(1);
    },
  );

  rowTest(
    "without a project the last declarations show the settings with their mark, a value is stored at once and no agent starts",
    async () => {
      spaceState.activeRootPath = null;
      stored = {
        agent: "codex",
        settings: [{ setting: "reasoning_effort", value: "high" }],
      };
      declarationsAnswer = () => [
        {
          agent: "codex",
          model: "gpt-5.6-luna",
          settings: settings(),
          declaredAt: 1,
          agentVersion: "0.163.0",
        },
      ];
      await mount();
      expect(trigger().textContent?.includes("GPT-5.6 Luna")).toBe(true);
      expect(trigger().textContent?.includes("High")).toBe(true);

      await click(trigger());
      expect(rowValue(m.sessions_chat_reasoning_level())).toBe("High");
      expect(
        popover()?.textContent?.includes(m.sessions_chat_settings_last_session()),
      ).toBe(true);
      await chooseValue("Mode", "Auto review");
      expect(lastCall("agent_default_set")).toEqual({
        defaultAgent: {
          agent: "codex",
          settings: [
            { setting: "reasoning_effort", value: "high" },
            { setting: "mode", value: "agent" },
          ],
        },
      });
      expect(rowValue("Mode")).toBe("Auto review");
      expect(
        calls.some((call) =>
          [
            "agent_runtime_hold_draft",
            "agent_runtime_set_setting",
            "agent_runtime_subscribe",
          ].includes(call.command),
        ),
      ).toBe(false);
    },
  );

  rowTest(
    "with two or more agents the settings window opens the agent choice, and an agent tab without a label names its agent on hover",
    async () => {
      await mount();
      await click(trigger());
      const tabs = agentTabs();
      expect(tabs.length).toBe(3);
      // The tab of the chosen agent carries its label; the others only an icon.
      const unlabeled = tabs.find(
        (tab) => tab.getAttribute("aria-selected") !== "true",
      );
      if (!unlabeled) throw new Error("no tab without a label");
      const name = unlabeled.getAttribute("aria-label");
      expect(name !== null && unlabeled.textContent?.includes(name) !== true).toBe(
        true,
      );
      expect(tooltip()).toBe(null);

      await act(async () => {
        unlabeled.parentElement!.dispatchEvent(
          new window.PointerEvent("pointermove", { bubbles: true }),
        );
      });
      // The app's tooltips show after 300 ms.
      await wait(150);
      expect(tooltip()).toBe(null);
      await wait(250);
      expect(tooltip()?.textContent?.includes(name!)).toBe(true);
      expect(popover() !== null).toBe(true);
    },
  );

  async function wait(ms: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  function tooltip() {
    return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
  }

  function staleNotes() {
    return Array.from(popover()?.querySelectorAll("p") ?? []).filter(
      (element) =>
        element.textContent === m.sessions_chat_setting_value_stale(),
    ).length;
  }

  function lastCall(command: string) {
    return calls.filter((call) => call.command === command).at(-1)?.payload;
  }

  function settings(current: { model?: string } = {}) {
    return [
      {
        id: "mode",
        name: "Mode",
        description: null,
        category: "mode",
        currentValue: "read-only",
        options: [
          { value: "read-only", name: "Read Only", description: null },
          { value: "agent", name: "Auto review", description: null },
        ],
      },
      {
        id: "collaboration_mode",
        name: "Collaboration mode",
        description: null,
        category: "other",
        currentValue: "default",
        options: [
          { value: "default", name: "Default", description: null },
          { value: "plan", name: "Plan", description: null },
        ],
      },
      {
        id: "model",
        name: "Model",
        description: null,
        category: "model",
        currentValue: current.model ?? "gpt-5.6-luna",
        options: [
          { value: "gpt-6-sol", name: "GPT-6 Sol", description: null },
          { value: "gpt-5.6-luna", name: "GPT-5.6 Luna", description: null },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        description: null,
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "Low", description: null },
          { value: "high", name: "High", description: null },
        ],
      },
    ];
  }

  function snapshot(session: typeof draftKey) {
    return {
      seq: 0,
      session,
      connection: "ready",
      turn: {
        turnId: null,
        phase: "none",
        lastOutcome: null,
        status: {
          state: "idle",
          stopReason: null,
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items: [],
      pending: null,
      history: { source: "live", available: true, truncatedItems: null },
      writer: "acp",
      settings: settings(),
      commands: [],
      usage: null,
      title: null,
    };
  }

  /** Delivers the next delta of a subscribed session. */
  async function deliver(sessionId: string, change: Record<string, unknown>) {
    const channel = channels.get(sessionId);
    if (!channel) throw new Error(`no subscription of ${sessionId}`);
    const index = channel.index++;
    await act(async () => {
      runCallback(channel.id, {
        index,
        message: { type: "delta", value: { seq: index, ...change } },
      });
    });
    await settle();
  }

  function runCallback(id: number, data: unknown) {
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          runCallback: (id: number, data: unknown) => void;
        };
      }
    ).__TAURI_INTERNALS__.runCallback(id, data);
  }

  /** The app with its settings window open on the agents. */
  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    // The app's root route without its screens.
    const router = createRouter({
      routeTree: createRootRoute({ component: AppProviders }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await settle();
    await act(async () => {
      useShellStore.getState().openAppSettings("providers");
    });
    await settle();
  }

  function trigger() {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        element
          .getAttribute("aria-label")
          ?.startsWith(m.settings_default_agent_button({ agent: "" })),
    );
    if (!button) throw new Error("no default agent entry");
    return button;
  }

  function popover() {
    return document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  }

  function agentTabs() {
    return Array.from(
      popover()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
    );
  }

  /** The labels of the main screen's setting rows, in their order. */
  function rowLabels() {
    return Array.from(
      popover()?.querySelectorAll<HTMLElement>("button, div") ?? [],
    )
      .map(
        (element) =>
          element.querySelector(":scope > span.flex-1")?.textContent ?? null,
      )
      .filter((label): label is string => label !== null);
  }

  function settingRow(label: string) {
    return Array.from(
      popover()?.querySelectorAll<HTMLElement>("button, div") ?? [],
    ).find(
      (element) =>
        element.querySelector(":scope > span.flex-1")?.textContent === label,
    );
  }

  function rowValue(label: string) {
    return (
      settingRow(label)?.querySelector(":scope > span.shrink-0")?.textContent ??
      null
    );
  }

  /** Opens the screen of a setting and chooses a value there. */
  async function chooseValue(label: string, option: string) {
    await click(settingRow(label));
    await click(
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
      ).find(
        (element) =>
          element.querySelector("span > span")?.textContent === option,
      ),
    );
  }

  async function click(element: Element | undefined) {
    if (!element) throw new Error("nothing to click");
    await act(async () => {
      element.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      element.dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true }),
      );
      element.dispatchEvent(
        new window.PointerEvent("pointerup", { bubbles: true, button: 0 }),
      );
      element.dispatchEvent(
        new window.MouseEvent("mouseup", { bubbles: true }),
      );
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
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
}

/** An agent the device found, ready and turned on. */
function agentSetup(agent: string) {
  return {
    agent,
    enabled: true,
    verdict: { state: "supported" },
    installHint: `https://example.test/${agent}`,
    canSignIn: true,
    cli: {
      adapter: agent,
      status: "ready",
      executablePath: `/Users/test/.bun/bin/${agent}`,
      version: "1.0.0",
      authenticated: true,
      code: null,
      message: null,
    },
    cliRange: { minimum: "1.0.0", testedUpTo: "1.0.0" },
    cliVersion: { state: "supported" },
    adapter: {
      package: `@agentclientprotocol/${agent}-acp`,
      pinnedVersion: "1.0.0",
      install: { state: "installed", version: "1.0.0" },
      requiredNodeMajor: 22,
      node: { state: "ready", path: "/usr/local/bin/node", version: "22.23.1" },
    },
  };
}

/** Svode tools installed for none of the agents. */
function mcpStatus() {
  const command = "/Users/test/.svode/bin/svode-mcp";
  return {
    server: {
      status: "installed",
      command,
      version: "0.0.9",
      runtime: { kind: "desktop", version: "0.0.9" },
    },
    clients: [],
    sharedSkill: {
      path: "/Users/test/.agents/skills/svode",
      state: "absent",
      readers: [],
      requiredBy: [],
    },
    manualConfig: {
      name: "svode",
      transport: "stdio",
      command,
      args: [],
      env: {},
    },
    doctor: { ok: true, messages: [], errors: [], bridgeCompatible: true },
  };
}
