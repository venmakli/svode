import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { AgentActorItem } from "../model/agent-actor-types";

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
  /** The answers of the next writes; an applied write by default. */
  let mutateAnswers: (() => unknown)[] = [];
  let versionCounter = 1;

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
      case "agent_actors_mutate": {
        const answer = mutateAnswers.shift();
        if (answer) return answer();
        versionCounter += 1;
        return {
          status: "applied",
          version: `v${versionCounter}`,
          persistence: { status: "committed" },
          rootPointer: null,
        };
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
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { createAgentAdapterDictionary } =
    await import("@/features/agent-adapters");
  const { CollectionPropertyPanel } =
    await import("@/features/properties/panel");
  const { createAgentActorsPresentationDescriptor } =
    await import("./agent-actors-presentation");
  const { AgentActorBindingPopover } =
    await import("./agent-actor-binding-popover");
  const { useAgentActorMutations } =
    await import("../hooks/use-agent-actor-mutations");

  const dictionary = createAgentAdapterDictionary(
    bindable.map(({ id, label }) => ({ id, displayName: label })),
  );
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
      mutateAnswers = [];
      versionCounter = 1;
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
    "the panel shows Space, Agent, Approval mode and Readiness in this order, and no Approval mode for the participant's agent",
    async () => {
      await mount(<Panel items={[item({})]} />);
      expect(panelKeys()).toEqual(["space", "agent", "approval", "status"]);
      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      await mount(
        <Panel
          items={[item({ binding: { kind: "participant" }, mode: null })]}
        />,
      );
      expect(panelKeys()).toEqual(["space", "agent", "status"]);
    },
  );

  bindingTest(
    "Agent: the popover changes the draft binding and saves it whole once it closes; the agent's draft session runs in the Space of the catalog only while it is open",
    async () => {
      await mount(<Panel items={[item({})]} />);
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
      // The draft session confirms the values the Agent keeps.
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol", mode: "agent" }),
      });
      await chooseValue(m.sessions_chat_model(), "GPT-5.6 Luna");
      expect(lastCall("agent_runtime_set_setting")).toEqual({
        session: codexDraftKey,
        value: { setting: "model", value: "gpt-5.6-luna" },
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-5.6-luna", mode: "agent" }),
      });
      await chooseValue("Approval", "Read Only");
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-5.6-luna", mode: "read-only" }),
      });
      // Nothing is written while the popover is open.
      expect(mutations()).toEqual([]);
      expect(lastCall("agent_runtime_release_draft")).toBe(undefined);

      await click(trigger());
      expect(popover()).toBe(null);
      expect(mutations()).toEqual([
        {
          expectedVersion: "v1",
          mutation: {
            kind: "update",
            actor: {
              binding: {
                agent: "codex",
                settings: [{ setting: "model", value: "gpt-5.6-luna" }],
              },
              description: null,
              id: ACTOR,
              name: "Docs Agent",
            },
            mode: { agent: "codex", setting: "mode", value: "read-only" },
          },
          ownerPath: "/repo/docs",
          projectPath: "/repo",
        },
      ]);
      await settle();
      expect(lastCall("agent_runtime_release_draft")).toEqual({ hold: 5 });
    },
  );

  bindingTest(
    "changing the agent leaves the mode unselected; Escape drops the draft",
    async () => {
      await mount(<Panel items={[item({})]} />);
      await click(trigger());
      await click(tab("Grok Build"));
      expect(popover() !== null).toBe(true);
      await escape();
      expect(popover()).toBe(null);
      expect(mutations()).toEqual([]);

      await click(trigger());
      await click(tab("Grok Build"));
      await click(trigger());
      expect(mutations().map((write) => write.mutation)).toEqual([
        {
          kind: "update",
          actor: {
            binding: { agent: "grok-build", settings: [] },
            description: null,
            id: ACTOR,
            name: "Docs Agent",
          },
          mode: null,
        },
      ]);
    },
  );

  bindingTest(
    "Approval mode opens the same popover on the mode's values and writes the mode only on this device",
    async () => {
      await mount(<Panel items={[item({})]} />);
      await click(trigger("approval"));
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/repo/docs",
      });
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol", mode: "agent" }),
      });
      expect(tabNames()).toEqual([]);
      expect(commandItems()).toEqual(["Read Only", "Auto review"]);
      await click(commandItem("Read Only"));
      await deliver("d1", {
        change: "settings",
        value: settings({ model: "gpt-6-sol", mode: "read-only" }),
      });
      await click(trigger("approval"));
      expect(mutations()).toEqual([
        {
          expectedVersion: "v1",
          mutation: {
            kind: "set_mode",
            actorId: ACTOR,
            mode: { agent: "codex", setting: "mode", value: "read-only" },
          },
          ownerPath: "/repo/docs",
          projectPath: "/repo",
        },
      ]);
      await settle();
      expect(lastCall("agent_runtime_release_draft")).toEqual({ hold: 5 });
    },
  );

  bindingTest(
    "an inherited Agent writes to the catalog of its owner Space",
    async () => {
      await mount(
        <Panel
          items={[
            item({ inherited: true, ownerLabel: "repo", ownerPath: "/repo" }),
          ]}
        />,
      );
      await click(trigger());
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/repo",
      });
      await click(tab("Grok Build"));
      await click(trigger());
      expect(mutations()[0]?.ownerPath).toBe("/repo");
    },
  );

  bindingTest(
    "a changed Agent is a conflict at Agent without a write; a read-only catalog shows the reason at Agent",
    async () => {
      mutateAnswers = [() => ({ status: "stale" })];
      await mount(<Panel items={[item({})]} />);
      await click(trigger());
      await click(tab("Grok Build"));
      await click(trigger());
      await settle();
      expect(propertyMessage("agent")).toBe(m.agent_actors_property_stale());
      expect(trigger().textContent?.includes("Codex")).toBe(true);

      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      await mount(
        <Panel
          items={[item({})]}
          readOnly={m.agent_actors_catalog_read_only()}
        />,
      );
      expect(propertyMessage("agent")).toBe(m.agent_actors_catalog_read_only());
      expect((trigger() as HTMLButtonElement).disabled).toBe(true);
      expect((trigger("approval") as HTMLButtonElement).disabled).toBe(true);
      expect(propertyMessage("approval")).toBe(null);
    },
  );

  bindingTest(
    "the participant's agent tab explains the binding, names this device's default agent, or leads to the settings without one",
    async () => {
      await mount(<Panel items={[item({})]} />);
      await click(trigger());
      await click(tab("Participant's agent"));
      expect(popover() !== null).toBe(true);
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
      await click(
        buttonIn(popover(), m.agent_actors_participant_choose_in_settings()),
      );
      expect(openedSettings).toBe(1);
      expect(popover()).toBe(null);
      // Leaving for the settings closes the popover, which saves the binding.
      expect(mutations().map((write) => write.mutation)).toEqual([
        {
          kind: "update",
          actor: {
            binding: { participant: true },
            description: null,
            id: ACTOR,
            name: "Docs Agent",
          },
          mode: null,
        },
      ]);
    },
  );

  bindingTest(
    "the participant's agent tab names the default agent of this device with its model",
    async () => {
      defaultAgent = {
        agent: "codex",
        settings: [{ setting: "model", value: "gpt-6-sol" }],
      };
      await mount(
        <Panel
          items={[item({ binding: { kind: "participant" }, mode: null })]}
        />,
      );
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
    "a kept value the agent no longer declares and a value of the mode's setting in the catalog show with a note",
    async () => {
      await mount(
        <Panel
          items={[
            item({
              binding: {
                agent: "codex",
                kind: "agent",
                settings: [
                  { setting: "model", value: "gpt-4-old" },
                  { setting: "mode", value: "agent" },
                ],
              },
              mode: null,
            }),
          ]}
        />,
      );
      await click(trigger());
      expect(rowValue(m.sessions_chat_model())).toBe("gpt-4-old");
      // Both the model and the hand-edited mode are marked.
      expect(staleNotes()).toBe(2);
      await escape();
      expect(mutations()).toEqual([]);
    },
  );

  bindingTest(
    "an agent without variants shows the kept values as they are with its recovery; values cannot change, the agent can",
    async () => {
      await mount(
        <Panel
          items={[
            item({
              binding: {
                agent: "claude-code",
                kind: "agent",
                settings: [
                  { setting: "model", value: "sonnet" },
                  { setting: "effort", value: "high" },
                ],
              },
              mode: { agent: "claude-code", setting: "mode", value: "plan" },
            }),
          ]}
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
      await click(trigger());
      expect(mutations().map((write) => write.mutation)).toEqual([
        {
          kind: "update",
          actor: {
            binding: { agent: "codex", settings: [] },
            description: null,
            id: ACTOR,
            name: "Docs Agent",
          },
          mode: null,
        },
      ]);
    },
  );

  bindingTest(
    "a binding this version cannot bind, as a custom agent of a V1 catalog, shows as unavailable and changes to another agent",
    async () => {
      await mount(
        <Panel
          items={[
            item({
              binding: {
                agent: "custom-mine",
                kind: "agent",
                settings: [{ setting: "model", value: "local" }],
              },
              mode: null,
            }),
          ]}
        />,
      );
      await click(trigger());
      expect(
        calls.some((call) => call.command === "agent_runtime_hold_draft"),
      ).toBe(false);
      expect(
        popover()?.textContent?.includes(m.settings_agents_state_deferred()),
      ).toBe(true);
      expect(rowValue("model")).toBe("local");
      await click(tab("Codex"));
      await click(trigger());
      expect(
        (mutations()[0]?.mutation as { actor: { binding: unknown } }).actor
          .binding,
      ).toEqual({ agent: "codex", settings: [] });
    },
  );

  bindingTest(
    "an agent without modes has no mode row; without a draft session its last declarations give the values, kept at once",
    async () => {
      await mount(
        <Panel
          items={[
            item({
              binding: { agent: "grok-build", kind: "agent", settings: [] },
              mode: null,
            }),
          ]}
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
      expect(
        calls.some((call) => call.command === "agent_runtime_set_setting"),
      ).toBe(false);
      await click(trigger());
      expect(mutations().map((write) => write.mutation)).toEqual([
        {
          kind: "update",
          actor: {
            binding: {
              agent: "grok-build",
              settings: [{ setting: "model", value: "grok-5-fast" }],
            },
            description: null,
            id: ACTOR,
            name: "Docs Agent",
          },
          mode: null,
        },
      ]);
    },
  );

  bindingTest(
    "the writes of one Agent run one after another, each from the version the previous one left; Agents of one catalog keep their own versions",
    async () => {
      const first = deferred<unknown>();
      mutateAnswers = [() => first.promise];
      const other = item({
        actorRef: "agent:01arz3ndektsv4rrffq69g5faw",
        id: "01arz3ndektsv4rrffq69g5faw",
        name: "Reviewer",
        version: "w1",
      });
      await mount(<Writer items={[item({}), other]} />);
      await click(buttonIn(document.body, "rename"));
      await click(buttonIn(document.body, "describe"));
      await click(buttonIn(document.body, "rename other"));
      // The second write of the Agent waits for the first; the other Agent
      // does not.
      expect(mutations().map((write) => write.expectedVersion)).toEqual([
        "v1",
        "w1",
      ]);
      await act(async () => {
        first.resolve({
          status: "applied",
          version: "v9",
          persistence: { status: "committed" },
          rootPointer: null,
        });
      });
      await settle();
      const writes = mutations();
      expect(writes.map((write) => write.expectedVersion)).toEqual([
        "v1",
        "w1",
        "v9",
      ]);
      // The second write keeps the name the first one wrote.
      expect(
        (
          writes[2]?.mutation as {
            actor: { name: string; description: string };
          }
        ).actor,
      ).toEqual({
        binding: {
          agent: "codex",
          settings: [{ setting: "model", value: "gpt-6-sol" }],
        },
        description: "Writes docs",
        id: ACTOR,
        name: "Docs",
      });
    },
  );

  bindingTest(
    "a new Agent is named after the Agents of its catalog and bound to the participant's agent",
    async () => {
      const created: (string | null)[] = [];
      await mount(
        <Writer
          items={[
            item({ name: "New agent" }),
            item({
              actorRef: "agent:01arz3ndektsv4rrffq69g5faw",
              id: "01arz3ndektsv4rrffq69g5faw",
              name: "New agent 2",
              ownerPath: "/repo",
              inherited: true,
            }),
          ]}
          onCreated={(id) => created.push(id)}
        />,
      );
      await click(buttonIn(document.body, "create"));
      expect(mutations()).toEqual([
        {
          expectedVersion: null,
          mutation: {
            kind: "create",
            actor: {
              binding: { participant: true },
              description: null,
              id: "01arz3ndektsv4rrffq69g5fax",
              name: "New agent 2",
            },
            mode: null,
          },
          ownerPath: "/repo/docs",
          projectPath: "/repo",
        },
      ]);
      expect(created).toEqual([
        JSON.stringify(["/repo/docs", "01arz3ndektsv4rrffq69g5fax"]),
      ]);
    },
  );

  const ACTOR = "01arz3ndektsv4rrffq69g5fav";

  function useEditing(items: readonly AgentActorItem[]) {
    const mutations = useAgentActorMutations({
      projectPath: "/repo",
      refresh: () => undefined,
      saveCatalog: () => undefined,
      snapshot: {
        agents: bindable,
        diagnostics: [],
        fingerprints: { "/repo/docs": "f", "/repo": "g" },
        launchSpacePath: "/repo/docs",
        items,
      },
    });
    return mutations;
  }

  function Panel({
    items,
    readOnly = null,
  }: {
    items: readonly AgentActorItem[];
    readOnly?: string | null;
  }) {
    const owner = useEditing(items);
    const descriptor = createAgentActorsPresentationDescriptor({
      actions: {
        createState: { status: "idle" },
        getDeleteState: () => ({ status: "idle" }),
        onAdd: () => undefined,
        onDelete: () => undefined,
      },
      agents: dictionary,
      editing: {
        getState: () =>
          readOnly
            ? { reason: readOnly, status: "disabled" }
            : { status: "idle" },
        update: (actor, edit) =>
          owner.write(
            actor,
            (current) => ({
              ...current,
              binding: edit.binding,
              mode: edit.mode,
            }),
            edit.since,
          ),
        renderPopover: (input, opensOnMode) => (
          <AgentActorBindingPopover
            agents={bindable}
            input={input}
            offers={offers as never}
            opensOnMode={opensOnMode}
            onOpenAgentSettings={() => (openedSettings += 1)}
            onRecheckOffers={() => undefined}
          />
        ),
      },
      facts: (actor) => ({
        model: null,
        mode:
          actor.binding.kind === "participant" ||
          actor.binding.agent === "grok-build"
            ? null
            : { kind: "agent_default" },
        readiness: "ready",
      }),
      inheritedVisible: false,
      items,
      spaceName: () => "Docs",
    });
    return (
      <CollectionPropertyPanel
        item={items[0]!}
        properties={descriptor.properties}
      />
    );
  }

  function Writer({
    items,
    onCreated = () => undefined,
  }: {
    items: readonly AgentActorItem[];
    onCreated?(id: string | null): void;
  }) {
    const owner = useEditing(items);
    const [, setErrors] = useState<string[]>([]);
    const keep = (write: Promise<void>) =>
      void write.catch((error: Error) =>
        setErrors((current) => [...current, error.message]),
      );
    return (
      <>
        <button
          type="button"
          onClick={() =>
            keep(
              owner.write(items[0]!, (state) => ({ ...state, name: "Docs" })),
            )
          }
        >
          rename
        </button>
        <button
          type="button"
          onClick={() =>
            keep(
              owner.write(items[0]!, (state) => ({
                ...state,
                description: "Writes docs",
              })),
            )
          }
        >
          describe
        </button>
        <button
          type="button"
          onClick={() =>
            keep(owner.write(items[1]!, (state) => ({ ...state, name: "R" })))
          }
        >
          rename other
        </button>
        <button
          type="button"
          onClick={() => void owner.create("/repo/docs").then(onCreated)}
        >
          create
        </button>
      </>
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
      version: "v1",
      ...patch,
    };
  }

  function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  function commandItems() {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).map((element) => element.querySelector("span > span")?.textContent ?? "");
  }

  function commandItem(option: string) {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).find(
      (element) => element.querySelector("span > span")?.textContent === option,
    );
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

  function settings(current: { model?: string; mode?: string } = {}) {
    return [
      {
        id: "mode",
        name: "Approval",
        description: null,
        category: "mode",
        currentValue: current.mode ?? "read-only",
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

  function lastCall(command: string) {
    return calls.filter((call) => call.command === command).at(-1)?.payload;
  }

  function trigger(property = "agent") {
    const button = document.querySelector<HTMLElement>(
      `button[data-collection-property-popover-trigger="${property}"]`,
    );
    if (!button) throw new Error(`no trigger of ${property}`);
    return button;
  }

  function panelKeys() {
    return Array.from(
      document.querySelectorAll("[data-collection-panel-property]"),
    ).map((row) => row.getAttribute("data-collection-panel-property"));
  }

  function propertyMessage(property: string) {
    return (
      document.querySelector(
        `[data-collection-panel-property="${property}"] [data-collection-panel-property-message]`,
      )?.textContent ?? null
    );
  }

  function mutations() {
    return calls
      .filter((call) => call.command === "agent_actors_mutate")
      .map((call) => call.payload);
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
