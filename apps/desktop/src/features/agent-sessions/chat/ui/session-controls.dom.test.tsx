import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AgentSessionKeyDto } from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_SESSION_CONTROLS_DOM !== "1") {
  test("session controls DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SESSION_CONTROLS_DOM: "1" },
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
  // React DOM reads the input events the document supports when it loads.
  const { createRoot } = await import("react-dom/client");

  const spaceState = {
    activeRootIcon: null,
    activeRootId: "root",
    activeRootName: "Project",
    activeRootPath: "/project",
    rootSpaces: [],
    spaces: [],
  };
  mock.module("@/features/space", () => ({
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  const key: AgentSessionKeyDto = {
    agent: "codex",
    namespace: "native",
    sessionId: "s1",
  };
  const draftKey: AgentSessionKeyDto = { ...key, sessionId: "d1" };
  /** Calls of the commands the controls use, with their arguments. */
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  /** How the next setting change ends. */
  let settingAnswer: () => unknown = () => null;
  /** The channel of each subscribed session and its next message index. */
  const channels = new Map<string, { id: number; index: number }>();
  let snapshotFor: (session: typeof key) => unknown = (session) =>
    snapshot(session);
  let draftSession: typeof key | null = draftKey;

  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, payload });
    if (command === "agent_runtime_subscribe") {
      const channel = payload.channel as { id: number };
      const session = payload.session as typeof key;
      channels.set(session.sessionId, { id: channel.id, index: 1 });
      setTimeout(() =>
        runCallback(channel.id, {
          index: 0,
          message: { type: "snapshot", value: snapshotFor(session) },
        }),
      );
      return 1;
    }
    if (command === "agent_runtime_set_setting") return settingAnswer();
    if (command === "agent_runtime_hold_draft") {
      return {
        hold: 5,
        check: {
          state: "ready",
          agent: { name: "codex-acp", version: "2.1.1" },
        },
        session: draftSession,
      };
    }
    if (command === "agent_runtime_start_session") {
      return {
        outcome: "started",
        session: draftSession ?? key,
        sessionId: "codex:d1",
        turnId: "turn-1",
      };
    }
    if (command === "agent_setup_chat_agents") {
      return {
        agents: [
          { agent: "codex", name: "Codex", offer: { state: "available" } },
        ],
        last: null,
      };
    }
    if (command === "agent_adapters_list_identities") {
      return [{ id: "codex", displayName: "Codex" }];
    }
    if (
      command === "agent_runtime_unsubscribe" ||
      command === "agent_runtime_release_draft"
    ) {
      return null;
    }
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { SessionChat } = await import("./session-chat");
  const { NewSessionDraft } = await import("./new-session-draft");
  const { newSessionDraftKey, writeComposerDraft } =
    await import("../model/composer");

  const mounted: Root[] = [];
  function controlsTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      calls.length = 0;
      channels.clear();
      settingAnswer = () => null;
      snapshotFor = (session) => snapshot(session);
      draftSession = draftKey;
      try {
        await fn();
      } finally {
        for (const root of mounted.splice(0)) {
          await act(async () => root.unmount());
        }
        document.body.innerHTML = "";
        window.sessionStorage.clear();
      }
    });
  }

  async function mount(element: React.ReactNode) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(<TooltipProvider>{element}</TooltipProvider>);
    });
    await settle();
  }

  controlsTest(
    "a setting shows the agent's value only once it confirms it, and a refusal keeps it",
    async () => {
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scopeLabel="Project" />,
      );
      const button = agentButton();
      expect(button.textContent?.includes("GPT-5.6 Luna")).toBe(true);
      expect(button.textContent?.includes("Low")).toBe(true);
      // The permission mode is its own choice under the field.
      expect(
        Boolean(
          buttonByLabel(m.sessions_chat_mode_choose({ mode: "Read Only" })),
        ),
      ).toBe(true);
      // Without a usage report there is no context indicator.
      expect(contextButton()).toBe(undefined);

      await click(button);
      expect(Boolean(section(m.sessions_chat_model()))).toBe(true);
      expect(Boolean(section(m.sessions_chat_reasoning_level()))).toBe(true);
      expect(Boolean(section("Collaboration mode"))).toBe(true);
      // From five models the block has a search; after the first send there
      // are no agent tabs.
      expect(
        Boolean(
          document.querySelector(
            `input[aria-label="${m.sessions_chat_model_search()}"]`,
          ),
        ),
      ).toBe(true);
      expect(
        document.querySelector(
          `[aria-label="${m.sessions_chat_agent_tabs()}"]`,
        ),
      ).toBeNull();

      await click(optionByText("GPT-6 Sol"));
      expect(lastCall("agent_runtime_set_setting")?.value).toEqual({
        setting: "model",
        value: "gpt-6-sol",
      });
      // Accepted by the call, not shown before the agent's settings say so.
      expect(agentButton().textContent?.includes("GPT-5.6 Luna")).toBe(true);
      await deliver("s1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol" }),
      });
      expect(agentButton().textContent?.includes("GPT-6 Sol")).toBe(true);

      settingAnswer = () => {
        throw {
          kind: "agent_runtime",
          code: "setting_refused",
          setting: "model",
          value: "gpt-5.5",
          reason: { kind: "agent", message: "not allowed" },
          message: "setting model=gpt-5.5 was refused",
        };
      };
      await click(optionByText("GPT-5.5"));
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_setting_refused({
            setting: "Model",
            value: "GPT-5.5",
            reason: "not allowed",
          }),
        ),
      ).toBe(true);
      expect(agentButton().textContent?.includes("GPT-6 Sol")).toBe(true);

      await deliver("s1", {
        change: "usage",
        value: { used: 160000, size: 200000, cost: null },
      });
      const context = contextButton();
      expect(context?.getAttribute("aria-label")).toBe(
        m.sessions_chat_context_label({ percent: "80%" }),
      );
      expect(context?.className?.includes("text-warning")).toBe(true);
    },
  );

  controlsTest(
    "an agent without declarations shows its icon and name without model or reasoning",
    async () => {
      snapshotFor = (session) => ({ ...snapshot(session), settings: [] });
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scopeLabel="Project" />,
      );
      expect(agentButton().textContent?.includes("Codex")).toBe(true);
      await click(agentButton());
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_model_not_declared(),
        ),
      ).toBe(true);
      expect(section(m.sessions_chat_reasoning_level())).toBe(undefined);
      expect(
        document.querySelector(
          `[aria-label^="${m.sessions_chat_mode_choose({ mode: "" })}"]`,
        ),
      ).toBeNull();
    },
  );

  controlsTest(
    "a draft changes the settings of its session and its first send goes to that session",
    async () => {
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenTerminal={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/project",
      });
      await click(agentButton());
      expect(
        Boolean(
          document.querySelector(
            `[aria-label="${m.sessions_chat_agent_tabs()}"]`,
          ),
        ),
      ).toBe(true);
      await click(optionByText("GPT-6 Sol"));
      expect(lastCall("agent_runtime_set_setting")).toEqual({
        session: draftKey,
        value: { setting: "model", value: "gpt-6-sol" },
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol" }),
      });

      writeComposerDraft(newSessionDraftKey("/project"), {
        ...(JSON.parse(
          window.sessionStorage.getItem(
            `svode:session-draft:${newSessionDraftKey("/project")}`,
          )!,
        ) as object),
        parts: [{ type: "text", text: "Fix it" }],
      });
      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      calls.length = 0;
      // After a reload the kept value applies to the new draft session.
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenTerminal={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      expect(lastCall("agent_runtime_set_setting")?.value).toEqual({
        setting: "model",
        value: "gpt-6-sol",
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol" }),
      });
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(lastCall("agent_runtime_start_session")).toEqual({
        agent: "codex",
        cwd: "/project",
        settings: [{ setting: "model", value: "gpt-6-sol" }],
        prompt: [{ type: "text", text: "Fix it" }],
        hold: 5,
      });
    },
  );

  controlsTest(
    "a draft without a draft session shows its settings after the first send",
    async () => {
      draftSession = null;
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenTerminal={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      await click(agentButton());
      expect(
        document.body.textContent?.includes(m.sessions_chat_model_after_send()),
      ).toBe(true);
      expect(
        calls.some((call) => call.command === "agent_runtime_subscribe"),
      ).toBe(false);
    },
  );

  controlsTest(
    "a declared command opens with / and goes into the text; without commands / is a character",
    async () => {
      snapshotFor = (session) => ({
        ...snapshot(session),
        commands: [
          { name: "review", description: "Review changes", hint: null },
        ],
      });
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scopeLabel="Project" />,
      );
      await openMenu(buttonByLabel(m.sessions_chat_attach()));
      expect(Boolean(menuItem(m.sessions_chat_attach_command()))).toBe(true);
      await pressKey(document.querySelector('[role="menu"]'), "Escape");
      await deliver("s1", { change: "commands", value: [] });
      await openMenu(buttonByLabel(m.sessions_chat_attach()));
      expect(Boolean(menuItem(m.sessions_chat_attach_project()))).toBe(true);
      expect(menuItem(m.sessions_chat_attach_command())).toBe(undefined);
    },
  );

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
          ["gpt-6.1-sol", "GPT-6.1 Sol"],
          ["gpt-6-sol", "GPT-6 Sol"],
          ["gpt-6-luna", "GPT-6 Luna"],
          ["gpt-5.6-luna", "GPT-5.6 Luna"],
          ["gpt-5.5", "GPT-5.5"],
        ].map(([value, name]) => ({ value, name, description: null })),
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

  function snapshot(session: typeof key) {
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

  function lastCall(command: string) {
    return calls.filter((call) => call.command === command).at(-1)?.payload;
  }

  function agentButton() {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        element
          .getAttribute("aria-label")
          ?.startsWith(m.sessions_chat_agent_button({ agent: "" })),
    );
    if (!button) throw new Error("no agent button");
    return button;
  }

  function contextButton() {
    return Array.from(document.querySelectorAll("button")).find((element) =>
      element
        .getAttribute("aria-label")
        ?.startsWith(
          m.sessions_chat_context_label({ percent: "" }).split(" ")[0],
        ),
    );
  }

  function section(label: string) {
    return Array.from(document.querySelectorAll("section")).find(
      (element) => element.getAttribute("aria-label") === label,
    );
  }

  function optionByText(text: string) {
    return Array.from(
      document.querySelectorAll(
        '[data-slot="command-item"], [data-slot="toggle-group-item"]',
      ),
    ).find((element) => element.textContent?.trim() === text);
  }

  function buttonByLabel(label: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.getAttribute("aria-label") === label,
    );
  }

  function menuItem(text: string) {
    return Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (element) => element.textContent?.includes(text),
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

  async function openMenu(trigger: HTMLElement | undefined) {
    if (!trigger) throw new Error("no menu trigger");
    await act(async () => {
      trigger.focus();
    });
    await pressKey(trigger, "Enter");
  }

  async function pressKey(element: Element | null, key: string) {
    if (!element) throw new Error("nothing to press a key in");
    await act(async () => {
      element.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
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
