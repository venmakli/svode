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
    getSpaceSnapshot: () => spaceState,
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
  /** How the next prompt ends. */
  let promptAnswer: () => unknown = () => "turn-2";
  /** How the next opening in the chat ends. */
  /** `attach`: an opening other than reading; `intent` says which. */
  let openAnswer: (attach: boolean, intent: string) => unknown = () => ({
    outcome: "opened",
    session: key,
    liveness: "free",
  });
  /** Messages the chat reported as accepted, by session. */
  const messages: string[] = [];
  /** The detail of each timeline item by id. */
  let details: Record<string, unknown> = {};
  /** The agents a draft offers. */
  let chatAgents = [{ id: "codex", name: "Codex" }];
  /** How holding a draft's agent ends. */
  let holdAnswer: () => unknown = () => ({
    hold: 5,
    check: {
      state: "ready",
      agent: { name: "codex-acp", version: "2.1.1" },
    },
    session: draftSession,
  });

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
    if (command === "agent_runtime_prompt") return promptAnswer();
    if (command === "agent_runtime_open_session") {
      return openAnswer(payload.intent !== "read", payload.intent as string);
    }
    if (command === "agent_runtime_detail") {
      return details[payload.itemId as string] ?? { outcome: "unavailable", reason: "not_provided" };
    }
    if (command === "agent_runtime_hold_draft") return holdAnswer();
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
        agents: chatAgents.map(({ id, name }) => ({
          agent: id,
          name,
          offer: { state: "available" },
        })),
        last: null,
      };
    }
    if (command === "agent_adapters_list_identities") {
      return chatAgents.map(({ id, name }) => ({ id, displayName: name }));
    }
    if (
      command === "agent_runtime_unsubscribe" ||
      command === "agent_runtime_release_draft" ||
      command === "agent_runtime_cancel"
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
  const { useSessionOpening } = await import("../hooks/use-session-opening");
  const { Sheet, SheetContent, SheetTitle } = await import("@/components/ui/sheet");
  const { AGENT_SESSION_CONTENT_ATTRIBUTE } = await import(
    "../../lib/session-content"
  );
  const { keepLayerOpenOnEscape } = await import("@/shared/lib/escape-key");
  const { NewSessionDraft } = await import("./new-session-draft");
  const { AgentSessionDraftMainSurface } = await import(
    "../../ui/session-main-surface"
  );
  const {
    newSessionDraftKey,
    readComposerDraft,
    sessionDraftKey,
    writeComposerDraft,
  } = await import("../model/composer");
  const { subscribeUserEdits } = await import("@/features/navigation");
  subscribeUserEdits((edit) => {
    if (edit.kind === "message") messages.push(edit.sessionId);
  });

  const mounted: Root[] = [];
  function controlsTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      calls.length = 0;
      channels.clear();
      settingAnswer = () => null;
      snapshotFor = (session) => snapshot(session);
      draftSession = draftKey;
      details = {};
      chatAgents = [{ id: "codex", name: "Codex" }];
      holdAnswer = () => ({
        hold: 5,
        check: {
          state: "ready",
          agent: { name: "codex-acp", version: "2.1.1" },
        },
        session: draftSession,
      });
      promptAnswer = () => "turn-2";
      openAnswer = () => ({ outcome: "opened", session: key, liveness: "free" });
      messages.length = 0;
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
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
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
      expect(rowValue(m.sessions_chat_model())).toBe("GPT-5.6 Luna");
      expect(rowValue(m.sessions_chat_reasoning_level())).toBe("Low");
      expect(rowValue("Collaboration mode")).toBe("Default");
      // After the first send the session's agent heads the popover, without
      // agent tabs or the agent settings link.
      expect(popover()?.textContent?.startsWith("Codex")).toBe(true);
      expect(popover()?.querySelector('[role="tablist"]')).toBeNull();
      expect(
        popover()?.textContent?.includes(m.sessions_chat_agent_settings()),
      ).toBe(false);

      let confirm: (value: unknown) => void = () => undefined;
      settingAnswer = () => new Promise((resolve) => (confirm = resolve));
      await chooseValue(m.sessions_chat_model(), "GPT-6 Sol");
      expect(lastCall("agent_runtime_set_setting")?.value).toEqual({
        setting: "model",
        value: "gpt-6-sol",
      });
      // Back on the main screen the row waits for the agent and keeps its
      // value until the agent's settings say otherwise.
      const spinner = () =>
        settingRow(m.sessions_chat_model())?.querySelector(".animate-spin");
      expect(spinner() === null).toBe(false);
      expect(rowValue(m.sessions_chat_model())).toBe("GPT-5.6 Luna");
      // Inactive for assistive tech while it waits, and it does not open.
      const waiting = settingRow(m.sessions_chat_model())!;
      expect(waiting.getAttribute("aria-disabled")).toBe("true");
      expect(waiting.getAttribute("aria-busy")).toBe("true");
      await click(waiting);
      await pressKey(waiting, "Enter");
      expect(popover()?.querySelector('[data-slot="command-item"]')).toBeNull();
      await act(async () => confirm(null));
      await settle();
      expect(spinner()).toBe(null);
      expect(
        settingRow(m.sessions_chat_model())?.hasAttribute("aria-disabled"),
      ).toBe(false);
      settingAnswer = () => null;
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
      await chooseValue(m.sessions_chat_model(), "GPT-5.5");
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
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
      );
      expect(agentButton().textContent?.includes("Codex")).toBe(true);
      await click(agentButton());
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_model_not_declared(),
        ),
      ).toBe(true);
      expect(settingRow(m.sessions_chat_reasoning_level())).toBe(undefined);
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
          onOpenAgentSettings={() => undefined}
        />,
      );
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/project",
      });
      // The host names the draft; the draft itself starts no terminal.
      expect(document.querySelector("header, h2")).toBeNull();
      expect(
        Array.from(document.querySelectorAll("button")).some((button) =>
          /terminal/i.test(button.textContent ?? ""),
        ),
      ).toBe(false);
      await click(agentButton());
      expect(
        Boolean(
          document.querySelector(
            `[aria-label="${m.sessions_chat_agent_tabs()}"]`,
          ),
        ),
      ).toBe(true);
      await chooseValue(m.sessions_chat_model(), "GPT-6 Sol");
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
      // The first send keeps the new session in Now.
      expect(messages).toEqual(["codex:d1"]);
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
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
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

  controlsTest(
    "Esc in a sheet that keeps it for the session stops the turn, Esc closing a menu does not",
    async () => {
      snapshotFor = (session) => {
        const value = snapshot(session);
        return { ...value, turn: { ...value.turn, turnId: "t1", phase: "running" } };
      };
      let closed = 0;
      await mount(
        <Sheet open onOpenChange={() => (closed += 1)}>
          <SheetContent
            onEscapeKeyDown={(event) => keepLayerOpenOnEscape(event)}
          >
            <SheetTitle>Session</SheetTitle>
            <div {...{ [AGENT_SESSION_CONTENT_ATTRIBUTE]: "" }}>
              <SessionChat
                sessionId="codex:s1"
                session={key}
                scope={{ kind: "project", name: "Project", icon: null }}
              />
            </div>
          </SheetContent>
        </Sheet>,
      );

      await openMenu(buttonByLabel(m.sessions_chat_attach()));
      await pressKey(document.querySelector('[role="menu"]'), "Escape");
      expect(document.querySelector('[role="menu"]')).toBe(null);
      expect(calls.some((call) => call.command === "agent_runtime_cancel")).toBe(
        false,
      );

      const field = document.querySelector<HTMLElement>(
        `[aria-label="${m.sessions_chat_composer_label()}"]`,
      );
      await act(async () => field?.focus());
      await pressKey(field, "Escape");
      expect(lastCall("agent_runtime_cancel")?.session).toEqual(key);
      expect(
        calls.filter((call) => call.command === "agent_runtime_cancel").length,
      ).toBe(1);
      expect(closed).toBe(0);
    },
  );

  controlsTest(
    "Esc in the main area stops the turn while a closed drawer stays mounted as the top layer",
    async () => {
      snapshotFor = (session) => {
        const value = snapshot(session);
        return { ...value, turn: { ...value.turn, turnId: "t1", phase: "running" } };
      };
      await mount(
        <>
          <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />
          <Sheet open={false} modal={false}>
            <SheetContent forceMount onEscapeKeyDown={keepLayerOpenOnEscape}>
              <SheetTitle>Terminal</SheetTitle>
            </SheetContent>
          </Sheet>
        </>,
      );

      const field = document.querySelector<HTMLElement>(
        `[aria-label="${m.sessions_chat_composer_label()}"]`,
      );
      await act(async () => field?.focus());
      await pressKey(field, "Escape");
      expect(lastCall("agent_runtime_cancel")?.session).toEqual(key);
    },
  );

  controlsTest(
    "a request card asks the request, shows its tool call as the subject and lists the options alike",
    async () => {
      details = {
        "toolu_bash": {
          outcome: "available",
          blocks: [{ type: "text", text: "List the files" }],
        },
        "toolu_plan": {
          outcome: "available",
          blocks: [{ type: "text", text: "1. Add the test\n2. Fix the bug" }],
        },
      };
      const request = (toolCallId: string, title: string, tool: string) => ({
        items: [
          {
            id: toolCallId,
            turnId: "t1",
            kind: "tool_call",
            tool,
            media: [],
            locations: [],
            mcpCalls: [],
            status: "pending",
            summary: title,
            hasDetail: true,
          },
        ],
        pending: {
          id: `perm-${toolCallId}`,
          kind: "permission",
          title,
          toolCallId,
          options: [
            { id: "allow", label: "Yes", kind: "allow_once" },
            {
              id: "always",
              label: "Yes, and don't ask again for ls commands in this project",
              kind: "allow_always",
            },
            { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once" },
          ],
          fields: [],
          state: "pending",
        },
      });
      snapshotFor = (session) => {
        const value = snapshot(session);
        return {
          ...value,
          turn: { ...value.turn, turnId: "t1", phase: "running" },
          ...request("toolu_bash", "`ls -la`", "execute"),
        };
      };
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
      );
      const card = document.querySelector<HTMLElement>(
        `[aria-label="${m.sessions_chat_request_permission()}"]`,
      )!;
      expect(card.querySelector("h3")?.textContent).toBe(
        m.sessions_chat_request_heading_execute(),
      );
      expect(
        card.querySelector("h3")?.parentElement?.textContent?.includes(
          m.sessions_chat_stop(),
        ),
      ).toBe(true);
      expect(card.querySelector("pre")?.textContent).toBe("ls -la");
      expect(card.querySelectorAll("pre").length).toBe(1);
      expect(card.textContent?.includes("List the files")).toBe(true);
      const options = [...card.querySelectorAll("button")].filter((button) =>
        ["Yes", "Yes, and", "No, and"].some((label) =>
          button.textContent?.startsWith(label),
        ),
      );
      expect(options.length).toBe(3);
      expect(new Set(options.map((option) => option.dataset.variant))).toEqual(
        new Set(["outline"]),
      );

      await deliver("s1", {
        change: "pending",
        value: request("toolu_plan", "Approve Plan", "switch_mode").pending,
      });
      await deliver("s1", {
        change: "item",
        value: request("toolu_plan", "Approve Plan", "switch_mode").items[0],
      });
      const plan = document.querySelector<HTMLElement>(
        `[aria-label="${m.sessions_chat_request_permission()}"]`,
      )!;
      expect(plan.querySelector("h3")?.textContent).toBe(
        m.sessions_chat_request_heading_plan(),
      );
      expect(plan.textContent?.includes("Approve Plan")).toBe(false);
      expect(plan.querySelector("ol")?.textContent?.includes("Fix the bug")).toBe(
        true,
      );
    },
  );

  controlsTest(
    "Page or project file in the + menu opens the search, which keeps focus",
    async () => {
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
      );
      // A click on + takes focus from the field, which jsdom does not do.
      const attach = buttonByLabel(m.sessions_chat_attach());
      await act(async () => attach?.focus());
      await openMenu(attach);
      await click(menuItem(m.sessions_chat_attach_project()));
      // Past the retries the editor makes to take focus itself.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await settle();
      const search = document.querySelector<HTMLElement>(
        `[aria-label="${m.sessions_chat_mention_search()}"]`,
      );
      expect(Boolean(search)).toBe(true);
      expect(document.activeElement).toBe(search);
    },
  );

  controlsTest(
    "an accepted message keeps the session in Now once; a refusal or an unsent message does not",
    async () => {
      const write = (text: string) =>
        writeComposerDraft(sessionDraftKey("codex:s1"), {
          parts: [{ type: "text", text }],
        });
      write("First");
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
      );
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(lastCall("agent_runtime_prompt")?.prompt).toEqual([
        { type: "text", text: "First" },
      ]);
      expect(messages).toEqual(["codex:s1"]);
      // The session showing the same turn reports nothing more.
      const running = snapshot(key);
      await deliver("s1", {
        change: "turn",
        value: { ...running.turn, turnId: "turn-2", phase: "running" },
      });
      await deliver("s1", {
        change: "turn",
        value: { ...running.turn, turnId: "turn-2", phase: "none" },
      });
      expect(messages).toEqual(["codex:s1"]);

      // A typed refusal keeps the draft and the session out of Now.
      promptAnswer = () => {
        throw { kind: "agent_runtime", code: "turn_active", message: "busy" };
      };
      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      write("Second");
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={{ kind: "project", name: "Project", icon: null }} />,
      );
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(messages).toEqual(["codex:s1"]);

      // An unknown outcome counts once the session shows a new turn.
      promptAnswer = () => {
        throw new Error("lost");
      };
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(messages).toEqual(["codex:s1"]);
      await deliver("s1", {
        change: "turn",
        value: { ...running.turn, turnId: "turn-3", phase: "running" },
      });
      expect(messages).toEqual(["codex:s1", "codex:s1"]);
    },
  );

  /** A session the chat opened by reading it, as the session peek shows it. */
  function ReadSession() {
    const opening = useSessionOpening("/project", "codex:s1");
    const state = opening.opening;
    if (state.state !== "opened") return null;
    return (
      <SessionChat
        sessionId="codex:s1"
        session={state.session}
        scope={{ kind: "project", name: "Project", icon: null }}
        epoch={state.epoch}
        continuation={{
          liveness: state.liveness,
          attaching: opening.attaching,
          refusal: opening.continueRefusal,
          sessionValues: state.sessionValues,
          attach: opening.attach,
          refresh: opening.refresh,
          refreshing: opening.refreshing,
          onCopyResumeCommand: null,
        }}
      />
    );
  }

  /** The chat reads the session; an attaching opening makes it driven. */
  function readUntilAttached() {
    let writer = "none";
    snapshotFor = (session) => ({ ...snapshot(session), writer });
    openAnswer = (attach) => {
      if (attach) writer = "acp";
      return { outcome: "opened", session: key, liveness: "free" };
    };
  }

  async function unmountAll() {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
  }

  controlsTest(
    "before a read session is attached its settings are chosen into the draft, which keeps them over a reload, and the first send attaches it with them",
    async () => {
      readUntilAttached();
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
      });
      await mount(<ReadSession />);
      expect(lastCall("agent_runtime_open_session")).toEqual({
        projectPath: "/project",
        sessionId: "codex:s1",
        intent: "read",
        settings: [],
      });
      const button = agentButton();
      expect(button.disabled).toBe(false);
      await click(button);
      await click(settingRow(m.sessions_chat_model()));
      expect(optionByText("GPT-6 Sol")?.getAttribute("data-disabled")).toBe("false");
      await click(optionByText("GPT-6 Sol"));
      await chooseValue(m.sessions_chat_reasoning_level(), "High");
      await openMenu(
        buttonByLabel(m.sessions_chat_mode_choose({ mode: "Read Only" })),
      );
      await click(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(
          (item) => item.textContent?.includes("Auto review"),
        ),
      );
      // Nothing reaches the agent before the send; the choice shows as chosen.
      expect(lastCall("agent_runtime_set_setting")).toBe(undefined);
      expect(agentButton().textContent?.includes("GPT-6 Sol")).toBe(true);
      expect(agentButton().textContent?.includes("High")).toBe(true);

      // A reload of the window keeps the choice in the session's draft.
      await unmountAll();
      await mount(<ReadSession />);
      expect(agentButton().textContent?.includes("GPT-6 Sol")).toBe(true);
      expect(
        Boolean(
          buttonByLabel(m.sessions_chat_mode_choose({ mode: "Auto review" })),
        ),
      ).toBe(true);

      await click(buttonByLabel(m.sessions_chat_send()));
      const sent = calls.map((call) => call.command);
      expect(lastCall("agent_runtime_open_session")).toEqual({
        projectPath: "/project",
        sessionId: "codex:s1",
        intent: "send",
        settings: [
          { setting: "model", value: "gpt-6-sol" },
          { setting: "reasoning_effort", value: "high" },
          { setting: "mode", value: "agent" },
        ],
      });
      expect(
        sent.lastIndexOf("agent_runtime_open_session") <
          sent.indexOf("agent_runtime_prompt"),
      ).toBe(true);
      expect(lastCall("agent_runtime_prompt")?.prompt).toEqual([
        { type: "text", text: "Go on" },
      ]);
      // Attached, the button shows what the agent confirmed, and a change
      // goes to the session.
      expect(agentButton().textContent?.includes("GPT-5.6 Luna")).toBe(true);
      expect(readComposerDraft(sessionDraftKey("codex:s1"))?.settings ?? null).toBe(
        null,
      );
      await click(agentButton());
      await chooseValue(m.sessions_chat_model(), "GPT-6 Luna");
      expect(lastCall("agent_runtime_set_setting")?.value).toEqual({
        setting: "model",
        value: "gpt-6-luna",
      });
    },
  );

  /** Opening intents and prompts the chat sent, in order. */
  function sent() {
    return calls
      .filter(
        (call) =>
          call.command === "agent_runtime_open_session" ||
          call.command === "agent_runtime_prompt",
      )
      .map((call) =>
        call.command === "agent_runtime_prompt"
          ? "prompt"
          : (call.payload.intent as string),
      );
  }

  function draftText() {
    return readComposerDraft(sessionDraftKey("codex:s1"))?.parts;
  }

  controlsTest(
    "with unknown liveness the first send attaches the read session and sends once, without a confirmation",
    async () => {
      let writer = "none";
      snapshotFor = (session) => ({ ...snapshot(session), writer });
      openAnswer = (attach) => {
        if (attach) writer = "acp";
        return { outcome: "opened", session: key, liveness: "unknown" };
      };
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
      });
      await mount(<ReadSession />);
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(sent()).toEqual(["read", "send", "prompt"]);
      expect(
        document.body.textContent?.includes(m.sessions_chat_attach_title()),
      ).toBe(false);
    },
  );

  controlsTest(
    "while a turn is open the first send waits for the inline confirmation: cancel keeps the draft, confirming sends once",
    async () => {
      let writer = "none";
      snapshotFor = (session) => ({ ...snapshot(session), writer });
      openAnswer = (_, intent) => {
        if (intent === "send") {
          return { outcome: "confirmation_required", turnOpen: true };
        }
        if (intent === "confirmed") writer = "acp";
        return { outcome: "opened", session: key, liveness: "unknown" };
      };
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
      });
      await mount(<ReadSession />);
      const card = () =>
        document.querySelector(
          `[aria-label="${m.sessions_chat_attach_title()}"]`,
        );
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(sent()).toEqual(["read", "send"]);
      expect(card()?.textContent?.includes(
        m.sessions_chat_attach_turn_open_description(),
      )).toBe(true);
      // A repeated send does not go past the card.
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(sent()).toEqual(["read", "send"]);

      await click(
        Array.from(card()?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent === m.project_cancel(),
        ),
      );
      expect(card()).toBeNull();
      expect(draftText()).toEqual([{ type: "text", text: "Go on" }]);

      await click(buttonByLabel(m.sessions_chat_send()));
      await click(
        Array.from(card()?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent === m.sessions_chat_attach_confirm(),
        ),
      );
      expect(sent()).toEqual(["read", "send", "send", "confirmed", "prompt"]);
      expect(card()).toBeNull();
    },
  );

  controlsTest(
    "a send another process refuses or the agent cannot attach sends nothing and keeps the draft",
    async () => {
      snapshotFor = (session) => ({ ...snapshot(session), writer: "none" });
      openAnswer = (attach) =>
        attach
          ? { outcome: "external_active" }
          : { outcome: "opened", session: key, liveness: "unknown" };
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
      });
      await mount(<ReadSession />);
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(sent()).toEqual(["read", "send"]);
      expect(
        document.body.textContent?.includes(m.sessions_chat_external_writer()),
      ).toBe(true);
      expect(draftText()).toEqual([{ type: "text", text: "Go on" }]);

      await unmountAll();
      calls.length = 0;
      openAnswer = (attach) =>
        attach
          ? { outcome: "unavailable", reason: { code: "adapter_not_installed" } }
          : { outcome: "opened", session: key, liveness: "unknown" };
      await mount(<ReadSession />);
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(sent()).toEqual(["read", "send"]);
      expect(
        document.body.textContent?.includes(
          m.settings_agents_state_adapter_missing(),
        ),
      ).toBe(true);
      expect(draftText()).toEqual([{ type: "text", text: "Go on" }]);
    },
  );

  controlsTest(
    "a chosen value the session refuses sends nothing and keeps the draft with the reason and the session's value",
    async () => {
      snapshotFor = (session) => ({ ...snapshot(session), writer: "none" });
      openAnswer = (attach) => {
        if (!attach) return { outcome: "opened", session: key, liveness: "free" };
        throw {
          kind: "agent_runtime",
          code: "setting_refused",
          setting: "model",
          value: "gpt-6-sol",
          reason: { kind: "agent", message: "not allowed" },
          message: "setting model=gpt-6-sol was refused",
        };
      };
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
        settings: {
          agent: "codex",
          values: [
            { setting: "model", value: "gpt-6-sol" },
            { setting: "reasoning_effort", value: "high" },
          ],
        },
      });
      await mount(<ReadSession />);
      expect(agentButton().textContent?.includes("GPT-6 Sol")).toBe(true);
      await click(buttonByLabel(m.sessions_chat_send()));

      expect(lastCall("agent_runtime_prompt")).toBe(undefined);
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_setting_refused({
            setting: "Model",
            value: "GPT-6 Sol",
            reason: "not allowed",
          }),
        ),
      ).toBe(true);
      // The refused model goes back to the session's own; the rest stays chosen.
      expect(agentButton().textContent?.includes("GPT-5.6 Luna")).toBe(true);
      expect(agentButton().textContent?.includes("High")).toBe(true);
      const draft = readComposerDraft(sessionDraftKey("codex:s1"));
      expect(draft?.parts).toEqual([{ type: "text", text: "Go on" }]);
      expect(draft?.settings?.values).toEqual([
        { setting: "reasoning_effort", value: "high" },
      ]);
    },
  );

  /**
   * A read session whose own last turn ran on `values`; an attaching
   * opening makes it driven unless `refuse` refuses it.
   */
  function readWithSessionValues(
    values: { setting: string; value: string }[],
    unavailableModel: string | null,
    refuse: (() => unknown) | null = null,
  ) {
    let writer = "none";
    snapshotFor = (session) => ({ ...snapshot(session), writer });
    openAnswer = (attach) => {
      if (!attach) {
        return {
          outcome: "opened",
          session: key,
          liveness: "free",
          sessionValues: { values, unavailableModel },
        };
      }
      if (refuse) {
        const refusal = refuse();
        refuse = null;
        throw refusal;
      }
      writer = "acp";
      return { outcome: "opened", session: key, liveness: "free" };
    };
  }

  controlsTest(
    "before a read session is attached it shows the model and reasoning of its own last turn, which its first send applies under the user's choices",
    async () => {
      readWithSessionValues(
        [
          { setting: "model", value: "gpt-6-luna" },
          { setting: "reasoning_effort", value: "high" },
        ],
        null,
        () => ({
          kind: "agent_runtime",
          code: "setting_refused",
          setting: "model",
          value: "gpt-6-luna",
          reason: { kind: "not_declared" },
          message: "setting model=gpt-6-luna was refused",
        }),
      );
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
      });
      await mount(<ReadSession />);
      expect(agentButton().textContent?.includes("GPT-6 Luna")).toBe(true);
      expect(agentButton().textContent?.includes("High")).toBe(true);
      await click(agentButton());
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_model_session_unavailable({ model: "GPT-6 Luna" }),
        ),
      ).toBe(false);
      await chooseValue(m.sessions_chat_reasoning_level(), "Low");
      expect(agentButton().textContent?.includes("Low")).toBe(true);

      // A value of the session the agent refuses is left out, and the
      // button goes back to what the agent reported.
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(lastCall("agent_runtime_open_session")?.settings).toEqual([
        { setting: "model", value: "gpt-6-luna" },
        { setting: "reasoning_effort", value: "low" },
      ]);
      expect(lastCall("agent_runtime_prompt")).toBe(undefined);
      expect(agentButton().textContent?.includes("GPT-5.6 Luna")).toBe(true);

      await click(buttonByLabel(m.sessions_chat_send()));
      expect(lastCall("agent_runtime_open_session")?.settings).toEqual([
        { setting: "reasoning_effort", value: "low" },
      ]);
      expect(lastCall("agent_runtime_prompt")?.prompt).toEqual([
        { type: "text", text: "Go on" },
      ]);
    },
  );

  controlsTest(
    "a model of the session the agent no longer offers is told in the popover and does not hold the send",
    async () => {
      readWithSessionValues([{ setting: "reasoning_effort", value: "high" }], "6 Astra");
      writeComposerDraft(sessionDraftKey("codex:s1"), {
        parts: [{ type: "text", text: "Go on" }],
      });
      await mount(<ReadSession />);
      // The button shows the agent's model, which the turn runs on.
      expect(agentButton().textContent?.includes("GPT-5.6 Luna")).toBe(true);
      await click(agentButton());
      // A note under the model row.
      const note = settingRow(m.sessions_chat_model())?.nextElementSibling;
      expect(note?.textContent).toBe(
        m.sessions_chat_model_session_unavailable({ model: "6 Astra" }),
      );
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(lastCall("agent_runtime_open_session")?.settings).toEqual([
        { setting: "reasoning_effort", value: "high" },
      ]);
      expect(lastCall("agent_runtime_prompt")?.prompt).toEqual([
        { type: "text", text: "Go on" },
      ]);
      // Attached, the line is gone with the session's own values.
      if (!settingRow(m.sessions_chat_model())) await click(agentButton());
      expect(
        popover()?.textContent?.includes(
          m.sessions_chat_model_session_unavailable({ model: "6 Astra" }),
        ),
      ).toBe(false);
    },
  );

  controlsTest(
    "while another process writes to a read session its settings stay unavailable",
    async () => {
      snapshotFor = (session) => ({ ...snapshot(session), writer: "none" });
      openAnswer = () => ({
        outcome: "opened",
        session: key,
        liveness: "external_active",
      });
      await mount(<ReadSession />);
      expect(
        buttonByLabel(m.sessions_chat_mode_choose({ mode: "Read Only" }))
          ?.disabled,
      ).toBe(true);
      expect(document.body.textContent?.includes(m.sessions_chat_external_writer())).toBe(
        true,
      );
    },
  );

  controlsTest(
    "while the runtime does not drive the session its rows show the values and open no screens",
    async () => {
      snapshotFor = (session) => ({ ...snapshot(session), connection: "closed" });
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={null} />,
      );
      await click(agentButton());
      expect(rowValue(m.sessions_chat_model())).toBe("GPT-5.6 Luna");
      expect(rowValue(m.sessions_chat_reasoning_level())).toBe("Low");
      expect(settingRow(m.sessions_chat_model())?.tagName).toBe("DIV");
      await click(settingRow(m.sessions_chat_model()));
      expect(popover()?.querySelector('[data-slot="command-item"]')).toBeNull();
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

  controlsTest(
    "a Home draft lists the projects, inactive ones with their reason, and moves once a choice is taken",
    async () => {
      const chosen: string[] = [];
      let allow = false;
      // The main area top bar gets the draft's Space and its last crumb.
      const header = () =>
        document.querySelector<HTMLElement>("[data-draft-header]")!;
      const probe = () => header().dataset.draftHeader;
      await mount(
        <AgentSessionDraftMainSurface
          draft={{ draftId: "d1", spacePath: "/project" }}
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
          renderHeader={({ spacePath, current }) => (
            <nav data-draft-header={spacePath}>{current}</nav>
          )}
          spaceChoices={{
            choices: [
              {
                path: "/project",
                name: "Project",
                icon: null,
                kind: "project",
                unavailable: null,
              },
              {
                path: "/notes",
                name: "Notes",
                icon: null,
                kind: "project",
                unavailable: null,
              },
              {
                path: "/other",
                name: "Other",
                icon: null,
                kind: "project",
                unavailable: "Open in another window",
              },
            ],
            choose: async (path) => {
              chosen.push(path);
              return allow;
            },
          }}
        />,
      );
      await openMenu(buttonByLabel(m.sessions_chat_space_choose()));
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      expect(items.map((item) => item.textContent)).toEqual([
        "Project",
        "Notes",
        "OtherOpen in another window",
      ]);
      expect(items[2].hasAttribute("data-disabled")).toBe(true);
      await click(menuItem("Notes"));
      expect(chosen).toEqual(["/notes"]);
      expect(buttonByLabel(m.sessions_chat_space_choose())?.textContent).toBe(
        "Project",
      );
      expect(probe()).toBe("/project");
      const current = header().querySelector("[data-slot=breadcrumb-page]");
      expect(current?.textContent).toBe(m.sessions_new_title());
      expect(current?.querySelector("svg") === null).toBe(false);
      allow = true;
      await openMenu(buttonByLabel(m.sessions_chat_space_choose()));
      await click(menuItem("Notes"));
      expect(buttonByLabel(m.sessions_chat_space_choose())?.textContent).toBe(
        "Notes",
      );
      expect(probe()).toBe("/notes");
      expect(lastCall("agent_runtime_hold_draft")).toEqual({
        agent: "codex",
        cwd: "/notes",
      });
    },
  );

  controlsTest(
    "the row under a session's composer shows its Space or project with the draft's icon, also under a request card",
    async () => {
      await mount(
        <>
          <SessionChat
            sessionId="codex:s1"
            session={key}
            scope={{ kind: "space", name: "Ideas", icon: "💡" }}
          />
          <SessionChat
            sessionId="codex:s2"
            session={{ ...key, sessionId: "s2" }}
            scope={{ kind: "space", name: "Notes", icon: null }}
          />
          <SessionChat
            sessionId="codex:s3"
            session={{ ...key, sessionId: "s3" }}
            scope={{ kind: "project", name: "Project", icon: null }}
          />
        </>,
      );
      expect(scopeMarkIcon(document, "Ideas")).toBe("💡");
      expect(scopeMarkIcon(document, "Notes")).toBe("lucide-folder-closed");
      expect(scopeMarkIcon(document, "Project")).toBe("lucide-box");
      // The label offers no choice.
      expect(buttonByLabel(m.sessions_chat_space_choose())).toBe(undefined);

      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      snapshotFor = (session) => ({
        ...snapshot(session),
        turn: { ...snapshot(session).turn, turnId: "t1", phase: "running" },
        pending: {
          id: "perm-1",
          kind: "permission",
          title: "Run it",
          toolCallId: null,
          options: [{ id: "allow", label: "Yes", kind: "allow_once" }],
          fields: [],
          state: "pending",
        },
      });
      await mount(
        <SessionChat
          sessionId="codex:s1"
          session={key}
          scope={{ kind: "space", name: "Ideas", icon: "💡" }}
        />,
      );
      expect(
        document.querySelector(
          `[aria-label="${m.sessions_chat_request_permission()}"]`,
        ) === null,
      ).toBe(false);
      expect(scopeMarkIcon(document, "Ideas")).toBe("💡");
    },
  );

  controlsTest(
    "a draft whose Space is not among its choices shows the kind's icon and the last segment of the path",
    async () => {
      await mount(
        <NewSessionDraft
          spacePath="/project/notes/ideas"
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      const inProject = buttonByLabel(m.sessions_chat_space_choose())!;
      expect(scopeMarkIcon(inProject, "ideas")).toBe("lucide-folder-closed");

      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      // Home before its projects load: the active project's root.
      await mount(
        <NewSessionDraft
          spacePath="/project"
          spaceChoices={{ choices: [], choose: async () => false }}
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      const onHome = buttonByLabel(m.sessions_chat_space_choose())!;
      expect(scopeMarkIcon(onHome, "project")).toBe("lucide-box");
    },
  );

  /** Six models with long descriptions, six reasoning levels and two two-valued settings. */
  function richSettings(current: { model?: string } = {}) {
    const long =
      "Latest workhorse model for coding and everyday reasoning across long sessions with tools";
    return [
      ...settings().filter((setting) => setting.category === "mode"),
      {
        id: "model",
        name: "Model",
        description: null,
        category: "model",
        currentValue: current.model ?? "m4",
        options: ["m1", "m2", "m3", "m4", "m5", "m6"].map((value, index) => ({
          value,
          name: `Model ${index + 1}`,
          description: index === 3 ? long : `Model number ${index + 1}`,
        })),
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        description: null,
        category: "thought_level",
        currentValue: "high",
        options: ["minimal", "low", "medium", "high", "xhigh", "max"].map(
          (value) => ({ value, name: value.toUpperCase(), description: null }),
        ),
      },
      {
        id: "collaboration_mode",
        name: "Collaboration mode",
        description: null,
        category: "other",
        currentValue: "default",
        options: [
          { value: "default", name: "Default", description: null },
          { value: "plan", name: "Plan", description: "Plans before it acts" },
        ],
      },
      {
        id: "fast_mode",
        name: "Fast mode",
        description: null,
        category: "other",
        currentValue: "off",
        options: [
          { value: "off", name: "Off", description: null },
          { value: "on", name: "On", description: null },
        ],
      },
    ];
  }

  controlsTest(
    "the agent popover shows a row of each setting with its value and opens its values on a screen of their own",
    async () => {
      snapshotFor = (session) => ({
        ...snapshot(session),
        settings: richSettings(),
      });
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={null} />,
      );
      await click(agentButton());
      // The main screen: rows with values, no lists or segments.
      expect(rowValue(m.sessions_chat_model())).toBe("Model 4");
      expect(rowValue(m.sessions_chat_reasoning_level())).toBe("HIGH");
      expect(rowValue("Collaboration mode")).toBe("Default");
      expect(rowValue("Fast mode")).toBe("Off");
      expect(popover()?.querySelector('[data-slot="command-item"]')).toBeNull();
      expect(
        popover()?.querySelector('[data-slot="toggle-group-item"]'),
      ).toBeNull();
      // The permission mode stays under the field.
      expect(settingRow("Mode")).toBe(undefined);

      await click(settingRow(m.sessions_chat_model()));
      const search = popover()?.querySelector<HTMLInputElement>(
        `input[aria-label="${m.sessions_chat_model_search()}"]`,
      );
      expect(document.activeElement === search).toBe(true);
      const items = () =>
        Array.from(
          popover()?.querySelectorAll<HTMLElement>(
            '[data-slot="command-item"]',
          ) ?? [],
        );
      expect(items().length).toBe(6);
      // The full description, not cut short.
      const described = optionByText("Model 4")!;
      const description = described.querySelector("span > span + span");
      expect(description?.textContent).toBe(
        "Latest workhorse model for coding and everyday reasoning across long sessions with tools",
      );
      expect(description?.className.includes("truncate")).toBe(false);
      // One check, on the confirmed value, where the highlight starts.
      expect(
        items()
          .filter((item) => item.dataset.checked === "true")
          .map((item) => item.dataset.value),
      ).toEqual(["m4"]);
      expect(
        items()
          .filter((item) => item.dataset.selected === "true")
          .map((item) => item.dataset.value),
      ).toEqual(["m4"]);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(search, "number 6");
        search!.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await settle();
      expect(items().map((item) => item.dataset.value)).toEqual(["m6"]);

      // Choosing a value changes it once and returns to the main screen,
      // with focus on the row.
      await click(optionByText("Model 6"));
      expect(
        calls
          .filter((call) => call.command === "agent_runtime_set_setting")
          .map((call) => call.payload.value),
      ).toEqual([{ setting: "model", value: "m6" }]);
      expect(Boolean(settingRow(m.sessions_chat_reasoning_level()))).toBe(true);
      expect(
        document.activeElement === settingRow(m.sessions_chat_model()),
      ).toBe(true);
      await deliver("s1", {
        change: "settings",
        value: richSettings({ model: "m6" }),
      });
      expect(rowValue(m.sessions_chat_model())).toBe("Model 6");

      // The confirmed value sends nothing.
      calls.length = 0;
      await chooseValue(m.sessions_chat_model(), "Model 6");
      expect(lastCall("agent_runtime_set_setting")).toBe(undefined);
      expect(Boolean(settingRow(m.sessions_chat_reasoning_level()))).toBe(true);

      // Reasoning of six levels: no search, the list takes the keys.
      await click(settingRow(m.sessions_chat_reasoning_level()));
      expect(
        popover()?.querySelector(
          `input[aria-label="${m.sessions_chat_model_search()}"]`,
        ),
      ).toBeNull();
      expect(items().length).toBe(6);
      expect(document.activeElement?.hasAttribute("cmdk-root")).toBe(true);
      await pressKey(document.activeElement, "ArrowDown");
      expect(
        items()
          .filter((item) => item.dataset.selected === "true")
          .map((item) => item.dataset.value),
      ).toEqual(["xhigh"]);
      await pressKey(document.activeElement, "Enter");
      expect(lastCall("agent_runtime_set_setting")?.value).toEqual({
        setting: "reasoning_effort",
        value: "xhigh",
      });

      // A two-valued setting is a row and a screen too; back returns.
      await click(settingRow("Fast mode"));
      expect(items().map((item) => item.textContent)).toEqual(["Off", "On"]);
      await click(
        Array.from(popover()?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent === "Back",
        ),
      );
      expect(document.activeElement === settingRow("Fast mode")).toBe(true);
    },
  );

  controlsTest(
    "a draft's agents are tabs: arrows move between them and Enter chooses one",
    async () => {
      chatAgents = [
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude Code" },
      ];
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      await click(agentButton());
      const tabs = () =>
        Array.from(
          popover()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
        );
      // The chosen agent names itself in the tab, another one by its label.
      expect(
        tabs().map(
          (tab) => tab.getAttribute("aria-label") ?? tab.textContent?.trim(),
        ),
      ).toEqual(["Codex", "Claude Code"]);
      expect(tabs()[0].textContent?.includes("Codex")).toBe(true);
      expect(tabs()[1].textContent?.includes("Claude Code")).toBe(false);
      expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual([
        "true",
        "false",
      ]);
      // The tooltip of a tab does not replace its active state.
      expect(tabs().map((tab) => tab.getAttribute("data-state"))).toEqual([
        "active",
        "inactive",
      ]);
      expect(rowValue(m.sessions_chat_model())).toBe("GPT-5.6 Luna");
      expect(
        popover()?.textContent?.includes(m.sessions_chat_agent_settings()),
      ).toBe(true);
      calls.length = 0;
      await act(async () => tabs()[0].focus());
      await pressKey(tabs()[0], "ArrowRight");
      expect(document.activeElement === tabs()[1]).toBe(true);
      expect(tabs()[1].getAttribute("aria-selected")).toBe("false");
      expect(lastCall("agent_runtime_hold_draft")).toBe(undefined);
      await pressKey(tabs()[1], "Enter");
      // The choice closes the popover (DF-217); it shows the agent again.
      expect(popover()).toBe(null);
      await click(agentButton());
      expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
      expect(tabs().map((tab) => tab.getAttribute("data-state"))).toEqual([
        "inactive",
        "active",
      ]);
      expect(tabs()[1].textContent?.includes("Claude Code")).toBe(true);
      expect(tabs()[0].textContent?.includes("Codex")).toBe(false);
      expect(lastCall("agent_runtime_hold_draft")?.agent).toBe("claude");
    },
  );

  controlsTest(
    "while the agent starts its rows are a skeleton, and an agent that needs a sign-in shows its recovery",
    async () => {
      let ready: (value: unknown) => void = () => undefined;
      holdAnswer = () => new Promise((resolve) => (ready = resolve));
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      await click(agentButton());
      expect(popover()?.querySelector('[aria-busy="true"]') === null).toBe(
        false,
      );
      expect(settingRow(m.sessions_chat_model())).toBe(undefined);
      await act(async () =>
        ready({
          hold: 5,
          check: { state: "auth_required", methods: [] },
          session: null,
        }),
      );
      await settle();
      expect(
        popover()?.textContent?.includes(m.settings_agents_state_sign_in()),
      ).toBe(true);
      const actions = Array.from(
        popover()?.querySelectorAll("button") ?? [],
      ).map((button) => button.textContent);
      expect(actions.includes(m.settings_agents_action_sign_in())).toBe(true);
      expect(actions.includes(m.sessions_chat_agent_open_settings())).toBe(
        true,
      );
      expect(settingRow(m.sessions_chat_model())).toBe(undefined);
    },
  );

  controlsTest(
    "choosing a draft's agent closes the popover and gives focus to the field, while arrows and a value keep it open",
    async () => {
      chatAgents = [
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude Code" },
      ];
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      const tabs = () =>
        Array.from(
          popover()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
        );
      await click(agentButton());
      await act(async () => tabs()[0].focus());
      await pressKey(tabs()[0], "ArrowRight");
      expect(popover() === null).toBe(false);
      expect(document.activeElement === tabs()[1]).toBe(true);

      await pressKey(tabs()[1], "Enter");
      expect(popover()).toBe(null);
      expect(lastCall("agent_runtime_hold_draft")?.agent).toBe("claude");
      expect(await fieldFocused()).toBe(true);

      // The chosen agent again: nothing to start, the popover still closes.
      await click(agentButton());
      expect(await fieldFocused()).toBe(false);
      calls.length = 0;
      await click(tabs()[1]);
      expect(popover()).toBe(null);
      expect(lastCall("agent_runtime_hold_draft")).toBe(undefined);
      expect(await fieldFocused()).toBe(true);

      await click(agentButton());
      await click(tabs()[0]);
      expect(popover()).toBe(null);
      expect(lastCall("agent_runtime_hold_draft")?.agent).toBe("codex");
      expect(await fieldFocused()).toBe(true);

      // A value returns to the main screen of the open popover.
      await click(agentButton());
      await chooseValue(m.sessions_chat_model(), "GPT-6 Sol");
      expect(lastCall("agent_runtime_set_setting")?.value).toEqual({
        setting: "model",
        value: "gpt-6-sol",
      });
      expect(popover() === null).toBe(false);
      expect(Boolean(settingRow(m.sessions_chat_model()))).toBe(true);
    },
  );

  controlsTest(
    "choosing an agent under more closes both popovers and gives focus to the field",
    async () => {
      chatAgents = [
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude Code" },
        { id: "gemini", name: "Gemini" },
      ];
      // Tabs of 60px in a row of 150: one tab fits beside "more".
      const restore = stubWidths(60, 150);
      try {
        await mount(
          <NewSessionDraft
            spacePath="/project"
            onStarted={() => undefined}
            onOpenAgentSettings={() => undefined}
          />,
        );
        await click(agentButton());
        await click(buttonByLabel(m.sessions_chat_agent_more()));
        const popovers = () =>
          document.querySelectorAll('[data-slot="popover-content"]').length;
        expect(popovers()).toBe(2);
        await click(
          Array.from(document.querySelectorAll('[role="tab"]')).find((tab) =>
            tab.textContent?.includes("Gemini"),
          ),
        );
        expect(popovers()).toBe(0);
        expect(lastCall("agent_runtime_hold_draft")?.agent).toBe("gemini");
        expect(await fieldFocused()).toBe(true);
      } finally {
        restore();
      }
    },
  );

  controlsTest(
    "a click in the field closes the agent popover and gives the field focus at once, a click elsewhere only closes it",
    async () => {
      const check = async () => {
        // The field's visible box; the popover leaves it in view.
        field().parentElement!.getBoundingClientRect = () =>
          new window.DOMRect(0, 0, 400, 80);
        await click(agentButton());
        expect(await fieldFocused()).toBe(false);
        await pressAt(200, 40);
        expect(popover()).toBe(null);
        expect(await fieldFocused()).toBe(true);

        await click(agentButton());
        await pressAt(200, 300);
        expect(popover()).toBe(null);
        expect(await fieldFocused()).toBe(false);
        expect(document.activeElement === agentButton()).toBe(true);
      };
      await mount(
        <SessionChat sessionId="codex:s1" session={key} scope={null} />,
      );
      await check();
      await unmountAll();
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => undefined}
        />,
      );
      await check();
    },
  );

  controlsTest(
    "the agent settings, the recovery settings and the sign-in close the popover before they open",
    async () => {
      let opened = 0;
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => (opened += 1)}
        />,
      );
      const popoverButton = (text: string) =>
        Array.from(popover()?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent === text,
        );
      await click(agentButton());
      await click(popoverButton(m.sessions_chat_agent_settings()));
      expect(popover()).toBe(null);
      expect(opened).toBe(1);

      await unmountAll();
      holdAnswer = () => ({
        hold: 5,
        check: { state: "auth_required", methods: [] },
        session: null,
      });
      await mount(
        <NewSessionDraft
          spacePath="/project"
          onStarted={() => undefined}
          onOpenAgentSettings={() => (opened += 1)}
        />,
      );
      await click(agentButton());
      await click(popoverButton(m.sessions_chat_agent_open_settings()));
      expect(popover()).toBe(null);
      expect(opened).toBe(2);

      await click(agentButton());
      await click(popoverButton(m.settings_agents_action_sign_in()));
      expect(popover()).toBe(null);
      expect(lastCall("agent_setup_sign_in")?.agent).toBe("codex");
    },
  );

  /** The composer's field. */
  function field() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    )!;
  }

  /** Focus is in the field once the editor's retries to take it are over. */
  async function fieldFocused() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    return field().contains(document.activeElement);
  }

  /** A press of the primary button at a point of the page. */
  async function pressAt(x: number, y: number) {
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        document.body.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
      }
    });
    await settle();
  }

  /** Every element as wide as `width` in a container `clientWidth` wide. */
  function stubWidths(width: number, clientWidth: number) {
    const proto = window.HTMLElement.prototype;
    const offset = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(proto, "clientWidth", {
      configurable: true,
      get: () => clientWidth,
    });
    return () => {
      if (offset) Object.defineProperty(proto, "offsetWidth", offset);
      delete (proto as { clientWidth?: number }).clientWidth;
    };
  }

  /** The emoji or icon class next to a Space name under the composer. */
  function scopeMarkIcon(root: ParentNode, name: string) {
    const label = Array.from(root.querySelectorAll("span.truncate")).find(
      (element) => element.textContent === name,
    );
    const icon = label?.previousElementSibling;
    if (!icon) return null;
    if (icon.tagName.toLowerCase() === "svg") {
      return (
        Array.from(icon.classList).find((name) =>
          ["lucide-box", "lucide-folder-closed"].includes(name),
        ) ?? null
      );
    }
    return icon.textContent;
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

  function popover() {
    return document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  }

  /** The row of a setting on the main screen of the agent popover. */
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
    await click(optionByText(option));
  }

  /** A value on a setting's screen by its name. */
  function optionByText(text: string) {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).find(
      (element) =>
        element.querySelector("span > span")?.textContent === text ||
        element.textContent?.trim() === text,
    );
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
