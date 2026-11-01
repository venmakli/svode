import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_AGENT_SETTINGS_POPOVER_DOM !== "1") {
  test("agent settings popover DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_SETTINGS_POPOVER_DOM: "1" },
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
  // cmdk keeps the selected item in view.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { createRoot } = await import("react-dom/client");

  const agents = [
    { agent: "codex", name: "Codex" },
    { agent: "claude-code", name: "Claude Code" },
  ];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command) => {
    if (command === "agent_adapters_list_identities") {
      return agents.map(({ agent, name }) => ({
        id: agent,
        displayName: name,
      }));
    }
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { AgentSettingsPopover } = await import("./agent-settings-popover");
  type HostProps = Partial<Parameters<typeof AgentSettingsPopover>[0]> & {
    extra?: boolean;
    recorded?: boolean;
    withoutVariants?: string[];
  };

  /** What the host was asked to do. */
  const events: string[] = [];

  /**
   * A host other than the composer: it keeps the chosen agent or the extra
   * tab, and closes the popover only where its props say so.
   */
  function Host({
    extra = false,
    recorded,
    withoutVariants,
    ...props
  }: HostProps) {
    const [open, setOpen] = useState(false);
    const [agent, setAgent] = useState<string | null>("codex");
    const [member, setMember] = useState(false);
    return (
      <AgentSettingsPopover
        trigger={<button type="button">Agent</button>}
        open={open}
        onOpenChange={setOpen}
        agent={member ? null : agent}
        choice={{
          agents,
          onChoose: (next) => {
            events.push(`agent:${next}`);
            setAgent(next);
            setMember(false);
          },
          readiness: {
            state: "checked",
            check: {
              state: "ready",
              agent: {
                name: "codex-acp",
                version: "2.1.1",
                capabilities: {
                  loadSession: true,
                  listSessions: true,
                  resumeSession: true,
                  closeSession: true,
                },
              },
            },
          },
          recovery: {
            onSignIn: null,
            onOpenSettings: () => events.push("settings"),
            onRetry: () => events.push("retry"),
          },
          settingsAfterSend: false,
          recorded,
          withoutVariants,
        }}
        extraTab={
          extra
            ? {
                label: "Member's agent",
                icon: <span>M</span>,
                selected: member,
                onChoose: () => {
                  events.push("extra");
                  setMember(true);
                },
                content: <p data-testid="extra">Each member runs it</p>,
              }
            : undefined
        }
        settings={settings()}
        canChange
        changing={null}
        onChange={(value) => events.push(`${value.setting}=${value.value}`)}
        {...props}
      />
    );
  }

  const mounted: Root[] = [];
  function popoverTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      events.length = 0;
      try {
        await fn();
      } finally {
        for (const root of mounted.splice(0)) {
          await act(async () => root.unmount());
        }
        document.body.innerHTML = "";
      }
    });
  }

  popoverTest(
    "a host without closing on a chosen agent keeps the popover open on the main screen, without its own bottom action",
    async () => {
      await mount(<Host />);
      await click(trigger());
      expect(agentTabs().length).toBe(2);
      expect(document.activeElement === agentTabs()[0]).toBe(true);
      expect(buttonByText(m.sessions_chat_agent_settings())).toBe(undefined);

      await click(agentTabs()[1]);
      expect(events).toEqual(["agent:claude-code"]);
      expect(popover() !== null).toBe(true);
      expect(agentTabs()[1].getAttribute("aria-selected")).toBe("true");

      await pressKey(agentTabs()[0], "Enter");
      expect(events).toEqual(["agent:claude-code", "agent:codex"]);
      expect(popover() !== null).toBe(true);
      expect(rowLabels()).toEqual([
        m.sessions_chat_model(),
        m.sessions_chat_reasoning_level(),
        "Collaboration mode",
      ]);
    },
  );

  popoverTest(
    "the mode row is last under the agent's label and opens the agent's modes",
    async () => {
      await mount(<Host modeRow />);
      await click(trigger());
      expect(rowLabels()).toEqual([
        m.sessions_chat_model(),
        m.sessions_chat_reasoning_level(),
        "Collaboration mode",
        "Approval preset",
      ]);
      expect(rowValue("Approval preset")).toBe("Read Only");

      await click(settingRow("Approval preset"));
      expect(optionTexts()).toEqual([
        "Read OnlyAsks before it edits",
        "Auto reviewEdits on its own",
      ]);
      await click(optionByText("Auto review"));
      expect(events).toEqual(["mode=agent"]);
      expect(popover() !== null).toBe(true);
      expect(rowLabels().at(-1)).toBe("Approval preset");
    },
  );

  popoverTest(
    "an extra tab follows the agent tabs, keeps the popover open and stands its content in place of the rows",
    async () => {
      let chosen = 0;
      await mount(<Host extra onAgentChosen={() => (chosen += 1)} />);
      await click(trigger());
      const tabs = agentTabs();
      expect(tabs.length).toBe(3);
      expect(
        (tabs[2].getAttribute("aria-label") ?? tabs[2].textContent)?.includes(
          "Member's agent",
        ),
      ).toBe(true);

      await click(tabs[2]);
      expect(events).toEqual(["extra"]);
      expect(chosen).toBe(0);
      expect(popover() !== null).toBe(true);
      expect(agentTabs()[2].getAttribute("aria-selected")).toBe("true");
      expect(Boolean(popover()?.querySelector('[data-testid="extra"]'))).toBe(
        true,
      );
      expect(rowLabels()).toEqual([]);

      await click(agentTabs()[0]);
      expect(events).toEqual(["extra", "agent:codex"]);
      expect(chosen).toBe(1);
      expect(Boolean(popover()?.querySelector('[data-testid="extra"]'))).toBe(
        false,
      );
      expect(rowLabels()[0]).toBe(m.sessions_chat_model());
    },
  );

  popoverTest(
    "the bottom action closes the popover before it leads away",
    async () => {
      const seen = { openAtAction: false };
      await mount(
        <Host
          onConfigureAgents={() => {
            seen.openAtAction = popover() !== null;
            events.push("configure");
          }}
        />,
      );
      await click(trigger());
      await click(buttonByText(m.sessions_chat_agent_settings()));
      expect(events).toEqual(["configure"]);
      expect(popover()).toBe(null);
      expect(seen.openAtAction).toBe(true);
    },
  );

  popoverTest(
    "values from the last session carry one marker after the rows, and a setting without variants for the model shows the agent default without a screen",
    async () => {
      await mount(<Host recorded withoutVariants={["reasoning_effort"]} />);
      await click(trigger());
      expect(rowLabels()).toEqual([
        m.sessions_chat_model(),
        m.sessions_chat_reasoning_level(),
        "Collaboration mode",
      ]);
      expect(rowValue(m.sessions_chat_reasoning_level())).toBe(
        m.sessions_chat_setting_agent_default(),
      );
      expect(
        settingRow(m.sessions_chat_reasoning_level())?.tagName === "BUTTON",
      ).toBe(false);
      expect(textCount(m.sessions_chat_setting_variants_after_model())).toBe(1);
      const marker = paragraphs().filter(
        (text) => text === m.sessions_chat_settings_last_session(),
      );
      expect(marker.length).toBe(1);
      expect(paragraphs().at(-1)).toBe(m.sessions_chat_settings_last_session());

      await click(settingRow(m.sessions_chat_model()));
      await click(optionByText("GPT-5.5"));
      expect(events).toEqual(["model=gpt-5.5"]);

      await unmountAll();
      await mount(<Host />);
      await click(trigger());
      expect(textCount(m.sessions_chat_settings_last_session())).toBe(0);
      expect(textCount(m.sessions_chat_setting_variants_after_model())).toBe(0);
      expect(rowValue(m.sessions_chat_reasoning_level())).toBe("Low");
    },
  );

  function paragraphs() {
    return Array.from(popover()?.querySelectorAll("p") ?? []).map(
      (element) => element.textContent ?? "",
    );
  }

  function textCount(text: string) {
    return paragraphs().filter((known) => known === text).length;
  }

  async function unmountAll() {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  }

  function settings() {
    return [
      {
        id: "mode",
        name: "Approval preset",
        description: null,
        category: "mode" as const,
        currentValue: "read-only",
        options: [
          {
            value: "read-only",
            name: "Read Only",
            description: "Asks before it edits",
          },
          {
            value: "agent",
            name: "Auto review",
            description: "Edits on its own",
          },
        ],
      },
      {
        id: "collaboration_mode",
        name: "Collaboration mode",
        description: null,
        category: "other" as const,
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
        category: "model" as const,
        currentValue: "gpt-6-sol",
        options: [
          { value: "gpt-6-sol", name: "GPT-6 Sol", description: null },
          { value: "gpt-5.5", name: "GPT-5.5", description: null },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        description: null,
        category: "thought_level" as const,
        currentValue: "low",
        options: [
          { value: "low", name: "Low", description: null },
          { value: "high", name: "High", description: null },
        ],
      },
    ];
  }

  async function mount(element: ReactNode) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(<TooltipProvider>{element}</TooltipProvider>);
    });
    await settle();
  }

  function trigger() {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === "Agent",
    );
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

  function optionTexts() {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).map((element) => element.textContent?.trim() ?? "");
  }

  function optionByText(text: string) {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).find(
      (element) => element.querySelector("span > span")?.textContent === text,
    );
  }

  function buttonByText(text: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === text,
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

  async function pressKey(element: Element | null, key: string) {
    if (!element) throw new Error("nothing to press a key in");
    await act(async () => {
      (element as HTMLElement).focus();
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
