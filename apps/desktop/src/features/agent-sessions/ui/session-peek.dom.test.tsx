import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentSession as ListedAgentSession } from "../api";
import type { AgentSessionTarget } from "../model";

if (process.env.SVODE_AGENT_SESSION_PEEK_DOM !== "1") {
  test("session peek DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_SESSION_PEEK_DOM: "1" },
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

  const closedPtys: string[] = [];
  /** PTYs that are tabs of the terminal panel, and the ones asked to show. */
  const panelPtys = new Set<string>();
  const shownPanelPtys: string[] = [];
  let exitListener: ((ptyId: string) => void) | null = null;
  mock.module("@/features/terminal/session-surface", () => ({
    ManagedTerminalSurface: ({
      ptyId,
      autoFocus,
    }: {
      ptyId: string;
      autoFocus?: boolean;
    }) => (
      <div
        tabIndex={0}
        data-terminal={ptyId}
        data-autofocus={String(Boolean(autoFocus))}
      />
    ),
    closeManagedTerminalSurface: async (ptyId: string) => {
      closedPtys.push(ptyId);
    },
    spawnManagedTerminalSurface: async () => ({
      ptyId: "pty-new",
      cwd: "/project",
    }),
    usePanelTerminal: (ptyId: string | null) => ({
      inPanel: ptyId !== null && panelPtys.has(ptyId),
      show: () => {
        if (ptyId) shownPanelPtys.push(ptyId);
      },
    }),
    subscribeManagedTerminalExit: (listener: (ptyId: string) => void) => {
      exitListener = listener;
      return () => {
        if (exitListener === listener) exitListener = null;
      };
    },
  }));
  mock.module("@/features/external-open", () => ({
    ExternalAppIcon: () => null,
  }));
  const spaceState = {
    activeRootName: "Project",
    activeRootPath: "/project",
    spaces: [],
  };
  mock.module("@/features/space", () => ({
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  let listed: ListedAgentSession[] = [];
  const commands: string[] = [];
  /** `attach` of each opening in the chat, and what the next one answers. */
  const openings: boolean[] = [];
  let openingOutcome: (attach: boolean) => unknown = () => ({
    outcome: "unsupported",
  });
  /** Writer and turn of the snapshot a chat subscription delivers. */
  let snapshotWriter: "none" | "acp" = "none";
  let snapshotTurn: "none" | "running" = "none";
  /** The message a reading of the history replays. */
  let replayedMessage = "Earlier";
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    commands.push(command);
    if (
      command === "agent_sessions_list" ||
      command === "agent_sessions_refresh"
    ) {
      return listResult(listed);
    }
    if (command === "agent_sessions_hot_status") {
      return {
        generatedAt: "2026-09-29T10:00:00Z",
        projectPath: payload.projectPath,
        sessions: [],
        checkedSessions: 0,
        updatedSessions: 0,
        skippedSessions: 0,
        sources: [],
      };
    }
    if (command === "agent_sessions_reenter") {
      return {
        mode: "spawned-resume-pty",
        sessionId: payload.sessionId,
        ptyId: `pty-resume-${String(payload.sessionId)}`,
        cwd: "/project",
      };
    }
    if (command === "agent_runtime_open_session") {
      openings.push(payload.attach as boolean);
      return openingOutcome(payload.attach as boolean);
    }
    if (command === "agent_runtime_subscribe") {
      const channel = payload.channel as { id: number };
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            runCallback: (id: number, data: unknown) => void;
          };
        }
      ).__TAURI_INTERNALS__;
      setTimeout(() =>
        internals.runCallback(channel.id, {
          index: 0,
          message: {
            type: "snapshot",
            value: readSnapshot(payload.session, snapshotWriter, snapshotTurn),
          },
        }),
      );
      return 1;
    }
    if (command === "agent_runtime_unsubscribe") return null;
    if (command === "agent_runtime_release_session") return null;
    if (command === "agent_runtime_prompt") return "turn-1";
    if (command === "list_project_openers") return [];
    if (command === "routines_resolve_launches") return [];
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { sessionDraftKey, writeComposerDraft } = await import(
    "../chat/model/composer"
  );
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useAgentSessionCatalog, useAgentSessionCatalogLifecycle } =
    await import("../hooks");
  let reloadCatalog: () => Promise<void> = async () => {};
  const { AgentSessionPeek } = await import("./session-peek");

  function Harness({
    projectPath,
    target,
    focusTerminal,
    onOpenChange,
  }: {
    projectPath: string;
    target: AgentSessionTarget | null;
    focusTerminal?: boolean;
    onOpenChange: (open: boolean) => void;
  }) {
    useAgentSessionCatalogLifecycle(projectPath);
    const load = useAgentSessionCatalog((state) => state.load);
    useEffect(() => {
      reloadCatalog = load;
    }, [load]);
    return (
      <TooltipProvider>
        <AgentSessionPeek
          target={target}
          focusTerminal={focusTerminal}
          onOpenChange={onOpenChange}
          onExpand={async () => true}
          onOpenRoutine={() => undefined}
        />
      </TooltipProvider>
    );
  }

  const mounted: Root[] = [];
  /** A test whose mounted peeks and portals are removed even when it fails. */
  function peekTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
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

  async function mountPeek(
    projectPath: string,
    target: AgentSessionTarget,
    focusTerminal?: boolean,
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    mounted.push(root);
    const openChanges: boolean[] = [];
    const render = async (next: AgentSessionTarget | null) => {
      await act(async () => {
        root.render(
          <Harness
            projectPath={projectPath}
            target={next}
            focusTerminal={focusTerminal}
            onOpenChange={(open) => openChanges.push(open)}
          />,
        );
      });
      await settle();
    };
    await render(target);
    return { openChanges };
  }

  peekTest(
    "viewing a history session does not resume it; continuing does once",
    async () => {
      listed = [session({ id: "codex:history", title: "History" })];
      commands.length = 0;
      await mountPeek("/p-history", {
        sessionId: "codex:history",
        launchId: null,
      });

      expect(document.body.textContent?.includes("History")).toBe(true);
      expect(commands.includes("agent_sessions_reenter")).toBe(false);
      expect(terminal()).toBeNull();

      await click(buttonByText(m.sessions_action_continue_in_terminal()));

      expect(
        commands.filter((command) => command === "agent_sessions_reenter"),
      ).toEqual(["agent_sessions_reenter"]);
      expect(terminal()?.dataset.terminal).toBe("pty-resume-codex:history");
      // Focus follows the explicit continue into the terminal.
      expect(terminal()?.dataset.autofocus).toBe("true");
    },
  );

  peekTest(
    "a session opens in the chat, which reads its history; its first send waits for the inline confirmation",
    async () => {
      const key = { agent: "codex", namespace: "native", sessionId: "read" };
      listed = [
        session({
          id: "codex:read",
          title: "Read",
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      commands.length = 0;
      snapshotWriter = "none";
      openingOutcome = () => ({
        outcome: "opened",
        session: key,
        liveness: "unknown",
      });
      writeComposerDraft(sessionDraftKey("codex:read"), { text: "Continue" });
      await mountPeek("/p-read", { sessionId: "codex:read", launchId: null });

      // Without a Svode writer the chat is the default; opening sends nothing.
      expect(openings).toEqual([false]);
      expect(commands.includes("agent_sessions_reenter")).toBe(false);
      expect(document.body.textContent?.includes("Earlier")).toBe(true);

      // Nothing reaches the agent before the user confirms this attempt.
      await click(buttonByLabel(m.sessions_chat_send()));
      expect(openings).toEqual([false]);
      expect(commands.includes("agent_runtime_prompt")).toBe(false);
      expect(
        document.body.textContent?.includes(m.sessions_chat_attach_description()),
      ).toBe(true);

      snapshotWriter = "acp";
      await click(buttonByText(m.sessions_chat_attach_confirm()));
      expect(openings).toEqual([false, true]);
      expect(
        commands.filter((command) => command === "agent_runtime_prompt"),
      ).toEqual(["agent_runtime_prompt"]);
    },
  );

  peekTest(
    "while another process writes to a session the chat shows a snapshot, which Refresh reads again",
    async () => {
      const key = { agent: "claude", namespace: "native", sessionId: "busy" };
      listed = [
        session({
          id: "claude:busy",
          source: "claude",
          title: "Busy",
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      commands.length = 0;
      snapshotWriter = "none";
      openingOutcome = () => ({
        outcome: "opened",
        session: key,
        liveness: "external_active",
      });
      await mountPeek("/p-busy", { sessionId: "claude:busy", launchId: null });

      // The history is read; the composer gives way to the manual fallback.
      expect(openings).toEqual([false]);
      expect(document.body.textContent?.includes("Earlier")).toBe(true);
      expect(document.body.textContent?.includes(m.sessions_chat_snapshot())).toBe(
        true,
      );
      expect(buttonByLabel(m.sessions_chat_send())).toBeNull();
      expect(Boolean(buttonByText(m.sessions_action_copy_resume_command()))).toBe(
        true,
      );

      // Refresh reads the history again without attaching; the other
      // process has finished, so the chat may continue the session.
      replayedMessage = "Later";
      openingOutcome = () => ({
        outcome: "opened",
        session: key,
        liveness: "unknown",
      });
      try {
        await click(buttonByText(m.sessions_chat_snapshot_refresh()));
      } finally {
        replayedMessage = "Earlier";
      }
      expect(openings).toEqual([false, false]);
      expect(document.body.textContent?.includes("Later")).toBe(true);
      expect(document.body.textContent?.includes(m.sessions_chat_snapshot())).toBe(
        false,
      );
      expect(Boolean(buttonByLabel(m.sessions_chat_send()))).toBe(true);
      expect(commands.includes("agent_runtime_prompt")).toBe(false);
    },
  );

  peekTest(
    "without read-only evidence the chat loads history only on request",
    async () => {
      const key = { agent: "hermes", namespace: "native", sessionId: "own" };
      listed = [
        session({
          id: "hermes:own",
          source: "hermes",
          title: "Own",
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      snapshotWriter = "acp";
      openingOutcome = (attach) =>
        attach
          ? { outcome: "opened", session: key, liveness: "unknown" }
          : { outcome: "confirmation_required" };
      await mountPeek("/p-own", { sessionId: "hermes:own", launchId: null });

      expect(openings).toEqual([false]);
      expect(document.body.textContent?.includes("Earlier")).toBe(false);
      expect(Boolean(buttonByText(m.sessions_action_open_in_terminal()))).toBe(true);

      await click(buttonByText(m.sessions_chat_load_history()));
      expect(openings).toEqual([false, true]);
      expect(document.body.textContent?.includes("Earlier")).toBe(true);
    },
  );

  peekTest(
    "a session with a live Svode terminal does not open in the chat",
    async () => {
      listed = [
        session({
          id: "codex:busyterm",
          title: "Terminal",
          runtime: { live: true, ptyId: "pty-busyterm" },
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      await mountPeek("/p-busyterm", {
        sessionId: "codex:busyterm",
        launchId: null,
      });

      await openMenu();
      const item = Array.from(
        document.querySelectorAll("[role='menuitem']"),
      ).find((element) =>
        element.textContent?.includes(m.sessions_action_open_in_chat()),
      );
      expect(item?.getAttribute("aria-disabled")).toBe("true");
      expect(
        item?.textContent?.includes(m.sessions_open_in_chat_terminal_live()),
      ).toBe(true);
    },
  );

  peekTest(
    "the chat follows a session the runtime drives without opening it",
    async () => {
      const key = {
        agent: "codex",
        namespace: "native",
        sessionId: "driven",
      } as const;
      listed = [
        session({
          id: "codex:driven",
          title: "Driven",
          runtime: { live: true, acpSession: key },
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      snapshotWriter = "acp";
      snapshotTurn = "none";
      await mountPeek("/p-driven", { sessionId: "codex:driven", launchId: null });

      expect(openings).toEqual([]);
      expect(document.body.textContent?.includes("Earlier")).toBe(true);
    },
  );

  peekTest("open in terminal is unavailable during a turn", async () => {
    const key = {
        agent: "codex",
        namespace: "native",
        sessionId: "busy",
      } as const;
    listed = [
      session({
        id: "codex:busy",
        title: "Busy",
        runtime: { live: true, acpSession: key },
        capabilities: { canResume: true, canOpenInChat: true },
      }),
    ];
    snapshotWriter = "acp";
    snapshotTurn = "running";
    await mountPeek("/p-busy", { sessionId: "codex:busy", launchId: null });

    await openMenu();
    const item = menuItemContaining(m.sessions_action_open_in_terminal());
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    expect(
      item?.textContent?.includes(m.sessions_chat_terminal_during_turn()),
    ).toBe(true);
    snapshotTurn = "none";
  });

  peekTest(
    "open in terminal releases the chat between turns, then resumes in the terminal",
    async () => {
      const key = {
        agent: "codex",
        namespace: "native",
        sessionId: "leave",
      } as const;
      listed = [
        session({
          id: "codex:leave",
          title: "Leave",
          runtime: { live: true, acpSession: key },
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      commands.length = 0;
      snapshotWriter = "acp";
      snapshotTurn = "none";
      await mountPeek("/p-leave", { sessionId: "codex:leave", launchId: null });

      await openMenu();
      await click(menuItem(m.sessions_action_open_in_terminal()));
      // The chat releases its writer before the terminal resumes the session.
      expect(
        commands.filter(
          (command) =>
            command === "agent_runtime_release_session" ||
            command === "agent_sessions_reenter",
        ),
      ).toEqual(["agent_runtime_release_session", "agent_sessions_reenter"]);
      expect(terminal()?.dataset.terminal).toBe("pty-resume-codex:leave");
    },
  );

  peekTest(
    "terminal actions of an agent without a terminal are inactive with the reason",
    async () => {
      const key = {
        agent: "custom-echo",
        namespace: "acp",
        sessionId: "own",
      } as const;
      listed = [
        session({
          id: "custom-echo:acp:own",
          source: "custom-echo",
          title: "Custom",
          resumeCommand: undefined,
          capabilities: { canResume: false, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      snapshotWriter = "none";
      snapshotTurn = "none";
      openingOutcome = () => ({
        outcome: "opened",
        session: key,
        liveness: "free",
      });
      await mountPeek("/p-custom", {
        sessionId: "custom-echo:acp:own",
        launchId: null,
      });

      expect(openings).toEqual([false]);
      await openMenu();
      const item = menuItemContaining(m.sessions_action_open_in_terminal());
      expect(item?.getAttribute("aria-disabled")).toBe("true");
      expect(item?.textContent?.includes(m.sessions_chat_no_terminal())).toBe(
        true,
      );
    },
  );

  peekTest(
    "a session whose agent cannot start opens in its terminal with the reason",
    async () => {
      listed = [
        session({
          id: "codex:off",
          title: "Off",
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      commands.length = 0;
      openingOutcome = () => ({
        outcome: "unavailable",
        reason: { code: "disabled" },
      });
      await mountPeek("/p-off", { sessionId: "codex:off", launchId: null });

      const reason = document.querySelector("[data-slot='marker']");
      expect(
        reason?.textContent?.includes(m.settings_agents_state_disabled()),
      ).toBe(true);
      expect(Boolean(buttonByText(m.sessions_action_continue_in_terminal()))).toBe(
        true,
      );
      // Opening it in its terminal resumes nothing by itself.
      expect(commands.includes("agent_sessions_reenter")).toBe(false);

      // "Open in chat" tries the chat again.
      await openMenu();
      await click(menuItem(m.sessions_action_open_in_chat()));
      expect(openings).toEqual([false, false]);
    },
  );

  peekTest(
    "a session the chat cannot open stays in its terminal with the reason",
    async () => {
      listed = [session({ id: "codex:plain", title: "Plain" })];
      openings.length = 0;
      await mountPeek("/p-plain", { sessionId: "codex:plain", launchId: null });

      expect(openings).toEqual([]);
      expect(
        document.body.textContent?.includes(
          m.sessions_chat_unavailable_not_openable(),
        ),
      ).toBe(true);
    },
  );

  peekTest("a peek opened to work in the terminal focuses it", async () => {
    listed = [
      session({
        id: "codex:focus",
        title: "Focus",
        runtime: { live: true, ptyId: "pty-focus" },
      }),
    ];
    await mountPeek(
      "/p-focus",
      { sessionId: "codex:focus", launchId: null },
      true,
    );
    expect(terminal()?.dataset.autofocus).toBe("true");
  });

  peekTest(
    "a session running in a terminal panel tab leads to the panel instead of a second terminal",
    async () => {
      listed = [
        session({
          id: "claude:panel",
          title: "Panel agent",
          runtime: { live: true, ptyId: "pty-panel" },
        }),
      ];
      panelPtys.add("pty-panel");
      try {
        await mountPeek("/p-panel", {
          sessionId: "claude:panel",
          launchId: null,
        });

        expect(document.body.textContent?.includes("Panel agent")).toBe(true);
        expect(terminal()).toBeNull();
        expect(
          document.body.textContent?.includes(
            m.sessions_terminal_in_panel_title(),
          ),
        ).toBe(true);

        await click(buttonByText(m.sessions_action_show_in_panel()));
        expect(shownPanelPtys).toEqual(["pty-panel"]);
      } finally {
        panelPtys.clear();
      }
    },
  );

  peekTest(
    "Esc in the terminal stays with the agent; Esc in the chrome closes",
    async () => {
      listed = [
        session({
          id: "codex:live",
          title: "Live",
          runtime: { live: true, ptyId: "pty-live" },
        }),
      ];
      const peek = await mountPeek("/p-esc", {
        sessionId: "codex:live",
        launchId: null,
      });

      expect(terminal()?.dataset.terminal).toBe("pty-live");
      expect(terminal()?.dataset.autofocus).toBe("false");

      await pressEscape(terminal()!);
      expect(peek.openChanges).toEqual([]);

      await pressEscape(buttonByLabel(m.sessions_action_more()));
      expect(peek.openChanges).toEqual([false]);
    },
  );

  peekTest("closing the terminal of a working agent asks first", async () => {
    listed = [
      session({
        id: "codex:busy",
        title: "Busy",
        status: {
          state: "running",
          source: "native_status_reader",
          confidence: "approximate",
        },
        runtime: { live: true, ptyId: "pty-busy" },
      }),
    ];
    closedPtys.length = 0;
    await mountPeek("/p-busy", {
      sessionId: "codex:busy",
      launchId: null,
    });

    await openMenu();
    await click(menuItem(m.sessions_action_close_terminal()));
    expect(closedPtys).toEqual([]);
    const dialog = document.querySelector("[role='alertdialog']");
    expect(
      dialog?.textContent?.includes(m.sessions_close_terminal_confirm_title()),
    ).toBe(true);

    const confirm = Array.from(dialog!.querySelectorAll("button")).find(
      (button) => button.textContent === m.sessions_action_close_terminal(),
    )!;
    await click(confirm);
    expect(closedPtys).toEqual(["pty-busy"]);
  });

  peekTest(
    "a provisional launch keeps its open peek when it becomes canonical",
    async () => {
      listed = [
        session({
          id: "codex:launch-1",
          title: "Routine launch",
          launchId: "launch-1",
          runtime: { live: true, provisional: true, ptyId: "pty-routine" },
        }),
      ];
      const peek = await mountPeek("/p-launch", {
        sessionId: "codex:launch-1",
        launchId: "launch-1",
      });
      expect(terminal()?.dataset.terminal).toBe("pty-routine");

      listed = [
        session({
          id: "codex:canonical",
          title: "Canonical routine session",
          launchId: "launch-1",
          runtime: { live: true, ptyId: "pty-routine" },
        }),
      ];
      await act(async () => reloadCatalog());
      await settle();

      expect(
        document.body.textContent?.includes("Canonical routine session"),
      ).toBe(true);
      expect(terminal()?.dataset.terminal).toBe("pty-routine");
      expect(peek.openChanges).toEqual([]);
    },
  );

  peekTest(
    "a terminal that ends while viewed offers to continue again",
    async () => {
      listed = [
        session({
          id: "codex:ending",
          title: "Ending",
          runtime: { live: true, ptyId: "pty-ending" },
        }),
      ];
      await mountPeek("/p-ending", {
        sessionId: "codex:ending",
        launchId: null,
      });
      expect(terminal()?.dataset.terminal).toBe("pty-ending");

      listed = [session({ id: "codex:ending", title: "Ending" })];
      await act(async () => exitListener?.("pty-ending"));
      await settle();

      expect(terminal()).toBeNull();
      expect(
        document.body.textContent?.includes(
          m.sessions_terminal_finished_title(),
        ),
      ).toBe(true);
      expect(
        Boolean(buttonByText(m.sessions_action_continue_in_terminal())),
      ).toBe(true);
    },
  );

  peekTest(
    "a session missing from the catalog says so after a fresh list",
    async () => {
      listed = [];
      commands.length = 0;
      await mountPeek("/p-missing", {
        sessionId: "codex:gone",
        launchId: null,
      });

      expect(
        document.body.textContent?.includes(m.sessions_missing_title()),
      ).toBe(true);
      expect(
        commands.filter((command) => command === "agent_sessions_list")
          .length >= 2,
      ).toBe(true);
    },
  );

  function terminal() {
    return document.querySelector<HTMLElement>("[data-terminal]");
  }

  function buttonByText(text: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;
  }

  function buttonByLabel(label: string) {
    return document.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
  }

  function menuItemContaining(text: string) {
    return Array.from(document.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent?.includes(text),
    ) as HTMLElement | undefined;
  }

  function menuItem(text: string) {
    return Array.from(document.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent?.trim() === text,
    ) as HTMLElement;
  }

  async function openMenu() {
    const trigger = buttonByLabel(m.sessions_action_more());
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();
  }

  async function click(element: Element | undefined) {
    if (!element) throw new Error("element not found");
    await act(async () => {
      (element as HTMLElement).click();
    });
    await settle();
  }

  async function pressEscape(element: HTMLElement) {
    await act(async () => {
      element.focus();
      element.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
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

  function session(
    overrides: Partial<ListedAgentSession> & Pick<ListedAgentSession, "id">,
  ): ListedAgentSession {
    return {
      source: "codex",
      sourceSessionId: overrides.id.replace(/^.+:/, ""),
      title: overrides.id,
      titleSource: "session-id",
      status: {
        state: "idle",
        stopReason: "end_turn",
        source: "native_status_reader",
        confidence: "approximate",
      },
      scopeKind: "project",
      scopeStatus: "ready",
      scopeConfidence: "exact",
      projectPath: "/project",
      lastActivityAt: "2026-09-29T10:00:00Z",
      resumeCommand: {
        display: "codex resume abc",
        program: "codex",
        args: ["resume", "abc"],
        cwd: "/project",
      },
      capabilities: {
        canResume: true,
        canOpenInChat: false,
      },
      ...overrides,
    };
  }

  function readSnapshot(
    session: unknown,
    writer: "none" | "acp",
    phase: "none" | "running",
  ) {
    return {
      seq: 0,
      session,
      connection: "ready",
      turn: {
        turnId: phase === "running" ? "turn-1" : null,
        phase,
        lastOutcome: null,
        status: {
          state: "idle",
          stopReason: null,
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items: [
        {
          kind: "user_message",
          id: "u1",
          turnId: "replay:1",
          status: null,
          summary: replayedMessage,
          hasDetail: false,
        },
      ],
      pending: null,
      history: { source: "replay", available: true, truncatedItems: null },
      writer,
      settings: [],
      title: null,
    };
  }

  function listResult(sessions: ListedAgentSession[]) {
    return {
      generatedAt: "2026-09-29T10:00:00Z",
      projectPath: "/project",
      status: "ok",
      cache: {
        mode: "fingerprint-hit",
        hit: true,
        sourceHits: 1,
        sourceMisses: 0,
      },
      sessions,
      summary: {
        returnedSessions: sessions.length,
        unresolvedCandidates: 0,
        incompleteCandidates: 0,
        malformedLines: 0,
        sourceErrors: 0,
      },
      sources: [],
    };
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
