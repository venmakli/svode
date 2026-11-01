import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  AgentActorDraft,
  AgentActorItem,
} from "../model/agent-actor-types";

if (process.env.SVODE_AGENT_ACTOR_BINDING_DOM !== "1") {
  test("Agent Actor binding editor DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_ACTOR_BINDING_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  // cmdk keeps the selected item in view.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { createRoot } = await import("react-dom/client");

  const bindable = [
    { id: "codex", label: "Codex" },
    { id: "claude-code", label: "Claude Code" },
    { id: "grok-build", label: "Grok Build" },
  ];
  const codexDraftKey = {
    agent: "codex",
    namespace: "native",
    sessionId: "d1",
  };
  /** Calls of the commands the editor uses, with their arguments. */
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  const channels = new Map<string, { id: number; index: number }>();
  let defaultAgent: unknown = null;
  let mutation: unknown = null;

  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    calls.push({ command, payload });
    switch (command) {
      case "agent_adapters_list_identities":
        return bindable.map(({ id, label }) => ({ id, displayName: label }));
      case "agent_default_get":
        return defaultAgent;
      case "agent_runtime_hold_draft":
        return holdDraft(payload.agent as string);
      case "agent_runtime_last_declarations":
        return lastDeclarations(payload.agent as string);
      case "agent_runtime_subscribe": {
        const channel = payload.channel as { id: number };
        const session = payload.session as typeof codexDraftKey;
        channels.set(session.sessionId, { id: channel.id, index: 1 });
        setTimeout(() =>
          runCallback(channel.id, {
            index: 0,
            message: { type: "snapshot", value: snapshot(session) },
          }),
        );
        return 1;
      }
      case "agent_actors_generate_id":
        return "01arz3ndektsv4rrffq69g5fax";
      case "agent_actors_mutate":
        mutation = payload.mutation;
        return {
          status: "applied",
          fingerprint: "next",
          persistence: { status: "clean" },
          rootPointer: null,
        };
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
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useRepositoryAccessPreflight } = await import("@/features/git");
  const { AgentActorEditorDialog } =
    await import("./agent-actor-editor-dialog");
  const { AgentActorDetail } = await import("./agent-actor-detail");
  const { createAgentActorDraft } = await import("../model/agent-actor-draft");
  const { useAgentActorMutations } =
    await import("../hooks/use-agent-actor-mutations");

  const offers = {
    agents: [
      { agent: "codex", name: "Codex", offer: { state: "available" } },
      {
        agent: "claude-code",
        name: "Claude Code",
        offer: { state: "sign_in_required" },
      },
      {
        agent: "grok-build",
        name: "Grok Build",
        offer: { state: "available" },
      },
      { agent: "custom-mine", name: "Mine", offer: { state: "available" } },
    ],
  } as const;

  const mounted: Root[] = [];
  let openedSettings = 0;
  function bindingTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      calls.length = 0;
      channels.clear();
      defaultAgent = null;
      mutation = null;
      openedSettings = 0;
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

  bindingTest(
    "the wizard creates an Agent with a concrete agent: Identity, Agent and Review, values and the mode from the agent's draft session in the Space of the catalog until the journey closes",
    async () => {
      const saved: AgentActorDraft[] = [];
      const initial = createAgentActorDraft("/repo/docs");
      initial.name = "Docs Agent";
      await mount(<Wizard initial={initial} onSave={(d) => saved.push(d)} />);
      expect(step()).toBe("identity");
      await clickButton("Continue");
      expect(step()).toBe("agent");
      expect(trigger().textContent).toBe(m.agent_actors_agent_choose());
      // Without an agent the journey does not go on.
      await clickButton("Continue");
      expect(step()).toBe("agent");
      expect(document.body.textContent?.includes("Choose an agent.")).toBe(
        true,
      );
      expect(
        calls.some((call) => call.command === "agent_runtime_hold_draft"),
      ).toBe(false);

      await click(trigger());
      // The bindable agents and the participant's agent; no custom agent.
      expect(tabNames()).toEqual([
        "Codex",
        "Claude Code",
        "Grok Build",
        "Participant's agent",
      ]);
      await click(tab("Codex"));
      expect(popover() !== null).toBe(true);
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/repo/docs",
      });
      // The mode is the last row under the agent's own label.
      expect(rowLabels()).toEqual([
        m.sessions_chat_model(),
        m.sessions_chat_reasoning_level(),
        "Collaboration mode",
        "Approval",
      ]);
      await chooseValue(m.sessions_chat_model(), "GPT-6 Sol");
      expect(lastCall("agent_runtime_set_setting")).toEqual({
        session: codexDraftKey,
        value: { setting: "model", value: "gpt-6-sol" },
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol" }),
      });
      await chooseValue("Approval", "Auto review");
      expect(draft()?.binding).toEqual({
        agent: "codex",
        kind: "agent",
        settings: [{ setting: "model", value: "gpt-6-sol" }],
      });
      expect(draft()?.mode).toEqual({
        agent: "codex",
        setting: "mode",
        value: "agent",
      });
      await escape();
      expect(popover()).toBe(null);
      expect(trigger().textContent?.includes("GPT-6 Sol")).toBe(true);

      await clickButton("Continue");
      expect(step()).toBe("review");
      const review = document.querySelector("[data-agent-actor-review]");
      expect(
        review?.querySelector("[data-agent-actor-binding]")?.textContent,
      ).toBe("GPT-6 SolLow");
      expect(review?.textContent?.includes("Approval")).toBe(true);
      expect(review?.textContent?.includes("Auto review")).toBe(true);
      expect(review?.textContent?.includes("On this device")).toBe(true);
      // The draft session stays through the steps of the open journey.
      expect(lastCall("agent_runtime_release_draft")).toBe(undefined);

      await clickButton("Add agent");
      expect(saved.at(-1)?.binding).toEqual({
        agent: "codex",
        kind: "agent",
        settings: [{ setting: "model", value: "gpt-6-sol" }],
      });
      // Closing the journey releases the agent's draft session.
      await clickButton("Cancel");
      await clickButton("Discard draft");
      expect(draft()).toBe(null);
      expect(lastCall("agent_runtime_release_draft")).toEqual({ hold: 5 });
    },
  );

  bindingTest(
    "the participant's agent tab explains the binding, names this device's default agent, or leads to the settings without one",
    async () => {
      const initial = createAgentActorDraft("/repo/docs");
      initial.name = "Mine";
      await mount(<Wizard initial={initial} onSave={() => undefined} />);
      await clickButton("Continue");
      await click(trigger());
      await click(tab("Participant's agent"));
      expect(popover() !== null).toBe(true);
      expect(draft()?.binding).toEqual({ kind: "participant" });
      const content = popover()?.querySelector(
        "[data-agent-actor-participant]",
      );
      expect(
        content?.textContent?.includes(
          m.agent_actors_participant_explanation(),
        ),
      ).toBe(true);
      expect(
        content?.textContent?.includes(m.agent_actors_participant_no_default()),
      ).toBe(true);
      expect(
        calls.some((call) => call.command === "agent_runtime_hold_draft"),
      ).toBe(false);
      await click(
        buttonIn(popover(), m.agent_actors_participant_choose_in_settings()),
      );
      expect(openedSettings).toBe(1);
      expect(popover()).toBe(null);
      expect(trigger().textContent).toBe("Participant's agent");
      await clickButton("Continue");
      expect(
        document
          .querySelector("[data-agent-actor-review]")
          ?.textContent?.includes("On this device"),
      ).toBe(false);
    },
  );

  bindingTest(
    "the participant's agent tab names the default agent of this device with its model",
    async () => {
      defaultAgent = {
        agent: "codex",
        settings: [{ setting: "model", value: "gpt-6-sol" }],
      };
      const initial = createAgentActorDraft("/repo/docs");
      initial.name = "Mine";
      initial.binding = { kind: "participant" };
      await mount(<Wizard initial={initial} onSave={() => undefined} />);
      await clickButton("Continue");
      await click(trigger());
      const content = popover()?.querySelector(
        "[data-agent-actor-participant]",
      );
      expect(content?.textContent?.includes("GPT-6 Sol")).toBe(true);
      expect(
        content?.textContent?.includes(m.agent_actors_participant_no_default()),
      ).toBe(false);
    },
  );

  bindingTest(
    "a kept value the agent no longer declares shows with a note and is kept; a value of the mode's setting in the catalog shows with a note and is not saved",
    async () => {
      const saved: AgentActorDraft[] = [];
      await mount(
        <EditForm
          item={item({
            binding: {
              agent: "codex",
              kind: "agent",
              settings: [
                { setting: "model", value: "gpt-4-old" },
                { setting: "mode", value: "agent" },
              ],
            },
            mode: null,
          })}
          onSave={(d) => saved.push(d)}
        />,
      );
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/repo/docs",
      });
      await click(trigger());
      expect(rowValue(m.sessions_chat_model())).toBe("gpt-4-old");
      // Both the model and the hand-edited mode are marked.
      expect(staleNotes()).toBe(2);
      await escape();
      await clickButton("Save");
      expect(saved.at(-1)?.binding).toEqual({
        agent: "codex",
        kind: "agent",
        settings: [{ setting: "model", value: "gpt-4-old" }],
      });
    },
  );

  bindingTest(
    "a change of the mode alone is a local-only write, any other change writes the catalog",
    async () => {
      const actor = item({});
      const mode = { agent: "codex", setting: "mode", value: "read-only" };
      await mount(<MutationHarness item={actor} draft={{ mode }} />);
      await clickButton("Apply");
      expect(mutation).toEqual({ kind: "set_mode", actorId: actor.id, mode });

      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      await mount(
        <MutationHarness item={actor} draft={{ mode, name: "Reviewer" }} />,
      );
      await clickButton("Apply");
      expect(mutation).toEqual({
        kind: "update",
        actor: {
          binding: {
            agent: "codex",
            settings:
              actor.binding.kind === "agent" ? actor.binding.settings : [],
          },
          description: null,
          id: actor.id,
          name: "Reviewer",
        },
        mode,
      });
    },
  );

  bindingTest(
    "an agent without variants shows the kept values as they are with its recovery; values cannot change, the agent can",
    async () => {
      await mount(
        <EditForm
          item={item({
            binding: {
              agent: "claude-code",
              kind: "agent",
              settings: [
                { setting: "model", value: "sonnet" },
                { setting: "effort", value: "high" },
              ],
            },
            mode: { agent: "claude-code", setting: "mode", value: "plan" },
          })}
          onSave={() => undefined}
        />,
      );
      await click(trigger());
      expect(
        popover()?.textContent?.includes(m.settings_agents_state_sign_in()),
      ).toBe(true);
      expect(
        buttonIn(popover(), m.settings_agents_action_sign_in()) === undefined,
      ).toBe(false);
      expect(
        buttonIn(popover(), m.sessions_chat_agent_open_settings()) ===
          undefined,
      ).toBe(false);
      expect(rowValue("model")).toBe("sonnet");
      expect(rowValue("effort")).toBe("high");
      expect(rowValue("mode")).toBe("plan");
      // The kept values are not choices.
      expect(settingRow("model")?.tagName).toBe("DIV");
      await click(tab("Codex"));
      expect(draft()?.binding).toEqual({
        agent: "codex",
        kind: "agent",
        settings: [],
      });
      expect(draft()?.mode).toBe(null);
    },
  );

  bindingTest(
    "a binding this version cannot bind, as a custom agent of a V1 catalog, shows as unavailable and changes to another agent",
    async () => {
      await mount(
        <EditForm
          item={item({
            binding: {
              agent: "custom-mine",
              kind: "agent",
              settings: [{ setting: "model", value: "local" }],
            },
            mode: null,
          })}
          onSave={() => undefined}
        />,
      );
      expect(
        document.querySelector("[data-agent-adapter-unknown]")?.textContent,
      ).toBe(m.agent_actors_adapter_unknown());
      expect(
        calls.some((call) => call.command === "agent_runtime_hold_draft"),
      ).toBe(false);
      await click(trigger());
      expect(
        popover()?.textContent?.includes(m.settings_agents_state_deferred()),
      ).toBe(true);
      expect(rowValue("model")).toBe("local");
      await click(tab("Codex"));
      expect(draft()?.binding).toEqual({
        agent: "codex",
        kind: "agent",
        settings: [],
      });
      expect(document.querySelector("[data-agent-adapter-unknown]")).toBe(null);
    },
  );

  bindingTest(
    "an agent without modes has no mode row; without a draft session its last declarations give the values, kept at once",
    async () => {
      await mount(
        <EditForm
          item={item({
            binding: { agent: "grok-build", kind: "agent", settings: [] },
            mode: null,
          })}
          onSave={() => undefined}
        />,
      );
      await click(trigger());
      expect(rowLabels()).toEqual([m.sessions_chat_model()]);
      expect(
        popover()?.textContent?.includes(
          m.sessions_chat_settings_last_session(),
        ),
      ).toBe(true);
      await chooseValue(m.sessions_chat_model(), "Grok 5 Fast");
      expect(draft()?.binding).toEqual({
        agent: "grok-build",
        kind: "agent",
        settings: [{ setting: "model", value: "grok-5-fast" }],
      });
      expect(draft()?.mode).toBe(null);
      expect(
        calls.some((call) => call.command === "agent_runtime_set_setting"),
      ).toBe(false);
    },
  );

  bindingTest(
    "the edit form holds the agent's draft session in the Space of the catalog and releases it once the form closes",
    async () => {
      const root = await mount(
        <EditForm item={item({})} onSave={() => undefined} />,
      );
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/repo/docs",
      });
      expect(lastCall("agent_runtime_release_draft")).toBe(undefined);
      await act(async () => root.unmount());
      mounted.splice(mounted.indexOf(root), 1);
      await settle();
      expect(lastCall("agent_runtime_release_draft")).toEqual({ hold: 5 });
    },
  );

  bindingTest(
    "the Detail shows the binding from the agent's last declarations without starting it or offering changes",
    async () => {
      await mount(<ReadOnly item={item({})} />);
      expect(trigger().textContent?.includes("GPT-6 Sol")).toBe(true);
      await click(trigger());
      expect(tabNames()).toEqual(["Codex"]);
      expect(rowValue("Approval")).toBe("Auto review");
      // The values only show here.
      expect(settingRow("Approval")?.tagName).toBe("DIV");
      expect(settingRow(m.sessions_chat_model())?.tagName).toBe("DIV");
      expect(
        calls.some((call) =>
          ["agent_runtime_hold_draft", "agent_runtime_subscribe"].includes(
            call.command,
          ),
        ),
      ).toBe(false);
    },
  );

  function Wizard({
    initial,
    onSave,
  }: {
    initial: AgentActorDraft;
    onSave(draft: AgentActorDraft): void;
  }) {
    const [current, setCurrent] = useState<AgentActorDraft | null>(initial);
    const accessRecovery = useRepositoryAccessPreflight();
    return (
      <>
        <span data-draft>{JSON.stringify(current)}</span>
        <AgentActorEditorDialog
          accessRecovery={accessRecovery}
          agents={bindable}
          draft={current}
          failure={null}
          offers={offers as never}
          pending={false}
          requesting={false}
          onChange={setCurrent}
          onClose={() => setCurrent(null)}
          onOpenAgentSettings={() => (openedSettings += 1)}
          onRecheckOffers={() => undefined}
          onSave={() => current && onSave(current)}
        />
      </>
    );
  }

  function EditForm({
    item: actor,
    onSave,
  }: {
    item: AgentActorItem;
    onSave(draft: AgentActorDraft): void;
  }) {
    const [current, setCurrent] = useState(() =>
      createAgentActorDraft(actor.ownerPath, actor),
    );
    return (
      <>
        <span data-draft>{JSON.stringify(current)}</span>
        <AgentActorDetail
          agents={bindable}
          draft={current}
          editMode
          offers={offers as never}
          onChange={setCurrent}
          onOpenAgentSettings={() => (openedSettings += 1)}
          onRecheckOffers={() => undefined}
          onSave={onSave}
        />
        <button type="submit" form={`agent-actor-detail-${actor.id}`}>
          Save
        </button>
      </>
    );
  }

  function ReadOnly({ item: actor }: { item: AgentActorItem }) {
    return (
      <AgentActorDetail
        agents={bindable}
        draft={createAgentActorDraft(actor.ownerPath, actor)}
        editMode={false}
        offers={offers as never}
        onChange={() => undefined}
        onOpenAgentSettings={() => (openedSettings += 1)}
        onRecheckOffers={() => undefined}
        onSave={() => undefined}
      />
    );
  }

  function MutationHarness({
    item: actor,
    draft: patch,
  }: {
    item: AgentActorItem;
    draft: Partial<AgentActorDraft>;
  }) {
    const mutations = useAgentActorMutations({
      detailController: null,
      projectPath: "/repo",
      refresh: () => undefined,
      saveCatalog: () => undefined,
      snapshot: {
        agents: bindable,
        diagnostics: [],
        fingerprints: { [actor.ownerPath]: "fingerprint" },
        launchSpacePath: actor.ownerPath,
        items: [actor],
      },
    });
    return (
      <button
        type="button"
        onClick={() =>
          void mutations.apply("update", actor.ownerPath, {
            ...createAgentActorDraft(actor.ownerPath, actor),
            ...patch,
          })
        }
      >
        Apply
      </button>
    );
  }

  function item(patch: Partial<AgentActorItem>): AgentActorItem {
    return {
      actorRef: "agent:01arz3ndektsv4rrffq69g5fav",
      binding: {
        agent: "codex",
        kind: "agent",
        settings: [{ setting: "model", value: "gpt-6-sol" }],
      },
      description: null,
      id: "01arz3ndektsv4rrffq69g5fav",
      inherited: false,
      mode: { agent: "codex", setting: "mode", value: "agent" },
      name: "Docs Agent",
      ownerLabel: "docs",
      ownerPath: "/repo/docs",
      ...patch,
    };
  }

  function holdDraft(agent: string) {
    const ready = {
      state: "ready",
      agent: { name: agent, version: "1.0.0" },
    };
    if (agent === "codex") {
      return {
        hold: 5,
        check: ready,
        session: codexDraftKey,
        keepsValuesUntilSend: false,
      };
    }
    if (agent === "claude-code") {
      return {
        hold: 7,
        check: { state: "auth_required", message: "" },
        session: null,
        keepsValuesUntilSend: false,
      };
    }
    return {
      hold: 6,
      check: ready,
      session: null,
      keepsValuesUntilSend: false,
    };
  }

  function lastDeclarations(agent: string) {
    if (agent === "codex") {
      return [
        {
          agent,
          model: "gpt-6-sol",
          settings: settings({ model: "gpt-6-sol" }),
          declaredAt: 1,
          agentVersion: "0.163.0",
        },
      ];
    }
    if (agent === "grok-build") {
      return [
        {
          agent,
          model: "grok-5",
          settings: [
            {
              id: "model",
              name: "Model",
              description: null,
              category: "model",
              currentValue: "grok-5",
              options: [
                { value: "grok-5", name: "Grok 5", description: null },
                {
                  value: "grok-5-fast",
                  name: "Grok 5 Fast",
                  description: null,
                },
              ],
            },
          ],
          declaredAt: 1,
          agentVersion: "0.4.0",
        },
      ];
    }
    return [];
  }

  function settings(current: { model?: string } = {}) {
    return [
      {
        id: "mode",
        name: "Approval",
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

  function snapshot(session: typeof codexDraftKey) {
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

  async function mount(element: ReactNode) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(<TooltipProvider>{element}</TooltipProvider>);
    });
    await settle();
    return root;
  }

  function draft(): AgentActorDraft | null {
    return JSON.parse(
      document.querySelector("[data-draft]")?.textContent ?? "null",
    );
  }

  function step() {
    return document
      .querySelector('[data-collection-create-flow="agent-actor"]')
      ?.getAttribute("data-collection-create-step");
  }

  function lastCall(command: string) {
    return calls.filter((call) => call.command === command).at(-1)?.payload;
  }

  function trigger() {
    const button = document.querySelector<HTMLElement>(
      "button[data-agent-actor-binding]",
    );
    if (!button) throw new Error("no binding row");
    return button;
  }

  function popover() {
    return document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  }

  function tabs() {
    return Array.from(
      popover()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
    );
  }

  function tabNames() {
    return tabs().map(
      (element) =>
        element.getAttribute("aria-label") ?? element.textContent ?? "",
    );
  }

  function tab(name: string) {
    return tabs().find(
      (element) =>
        (element.getAttribute("aria-label") ?? element.textContent) === name,
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

  function staleNotes() {
    return Array.from(popover()?.querySelectorAll("p") ?? []).filter(
      (element) =>
        element.textContent === m.sessions_chat_setting_value_stale(),
    ).length;
  }

  function buttonIn(container: Element | null, label: string) {
    return Array.from(container?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent?.trim() === label,
    );
  }

  async function clickButton(label: string) {
    const button = buttonIn(document.body, label);
    if (!button) throw new Error(`no button ${label}`);
    await click(button);
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

  async function escape() {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
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
