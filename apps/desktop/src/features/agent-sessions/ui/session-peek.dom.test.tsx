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
  const realExternalOpen = await import("@/features/external-open");
  mock.module("@/features/external-open", () => ({
    ...realExternalOpen,
    ExternalAppIcon: () => null,
  }));
  const spaceState = {
    activeRootName: "Project",
    activeRootPath: "/project",
    rootSpaces: [],
    spaces: [] as { id: string; path: string; name: string; status: string }[],
  };
  mock.module("@/features/space", () => ({
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  let listed: ListedAgentSession[] = [];
  /** Holds the session lists back, as while a session is being checked. */
  let listGate: Promise<void> | null = null;
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
  /** Prompts the runtime accepted, and files that are no longer there. */
  const prompts: unknown[] = [];
  const missingPaths = new Set<string>();
  /** Attachments the shell was asked to open. */
  const openedAttachments: string[] = [];
  /** The Routine runs the Routines owner resolves sessions to. */
  let routineLinks: {
    launchId: string;
    agentSessionId: string;
    launch: Record<string, unknown>;
  }[] = [];
  /** The installed external applications, and what they were asked to open. */
  const externalApps = [
    {
      id: "file_manager",
      label: "Finder",
      kind: "file_manager",
      isDefault: true,
      icon: null,
    },
    { id: "terminal", label: "Terminal", kind: "terminal", isDefault: false, icon: null },
    { id: "iterm2", label: "iTerm2", kind: "terminal", isDefault: false, icon: null },
  ];
  const openedApps: unknown[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    commands.push(command);
    if (
      command === "agent_sessions_list" ||
      command === "agent_sessions_refresh"
    ) {
      return listGate
        ? listGate.then(() => listResult(listed))
        : listResult(listed);
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
    if (command === "agent_runtime_prompt") {
      prompts.push(payload.prompt);
      return "turn-1";
    }
    if (command === "path_exists") return !missingPaths.has(String(payload.path));
    if (command === "list_project_openers") return externalApps;
    if (command === "open_project_in_tool") {
      openedApps.push(payload);
      return null;
    }
    if (command === "agent_setup_chat_agents") return { agents: [], last: null };
    if (command === "routines_resolve_launches") {
      const launchIds = payload.launchIds as string[];
      const sessionIds = payload.sessionIds as string[];
      return routineLinks.filter(
        (link) =>
          launchIds.includes(link.launchId) ||
          sessionIds.includes(link.agentSessionId),
      );
    }
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
  const { sessionDraftKey, writeComposerDraft } = await import(
    "../chat/model/composer"
  );
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { AttachmentOpenerContext } = await import(
    "../chat/hooks/use-attachment-opener"
  );
  const { useAgentSessionCatalog, useAgentSessionCatalogLifecycle } =
    await import("../hooks");
  let reloadCatalog: () => Promise<void> = async () => {};
  const { AgentSessionPeek } = await import("./session-peek");
  const { AgentSessionMainSurface } = await import("./session-main-surface");
  const { ProjectExternalOpenButton } = await import("@/features/external-open");

  function Harness({
    projectPath,
    target,
    focusTerminal,
    onOpenChange,
    main = false,
  }: {
    projectPath: string;
    target: AgentSessionTarget | null;
    focusTerminal?: boolean;
    onOpenChange: (open: boolean) => void;
    /** The session in the main area, its top bar part in `[data-main-header]`. */
    main?: boolean;
  }) {
    useAgentSessionCatalogLifecycle(projectPath);
    const load = useAgentSessionCatalog((state) => state.load);
    useEffect(() => {
      reloadCatalog = load;
    }, [load]);
    return (
      <TooltipProvider>
        <AttachmentOpenerContext.Provider
          value={(attachment) => openedAttachments.push(attachment.path)}
        >
          {main && target ? (
            <AgentSessionMainSurface
              target={target}
              focus={false}
              onOpenRoutine={() => undefined}
              renderHeader={({ spacePath, current, menu, openWith }) => (
                <div data-main-header data-space={spacePath}>
                  {current}
                  {menu}
                  <ProjectExternalOpenButton
                    projectPath={projectPath}
                    objectGroup={openWith ?? undefined}
                  />
                </div>
              )}
            />
          ) : (
            <AgentSessionPeek
              target={target}
              focusTerminal={focusTerminal}
              onOpenChange={onOpenChange}
              onExpand={async () => true}
              onOpenRoutine={() => undefined}
            />
          )}
        </AttachmentOpenerContext.Provider>
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
        window.localStorage.clear();
      }
    });
  }

  async function mountPeek(
    projectPath: string,
    target: AgentSessionTarget,
    focusTerminal?: boolean,
    main = false,
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
            main={main}
          />,
        );
      });
      await settle();
    };
    await render(target);
    return { openChanges };
  }

  peekTest(
    "the session peek shows the Changes of the session's Space before Expand",
    async () => {
      spaceState.spaces = [
        { id: "docs", path: "/project/docs", name: "Docs", status: "ready" },
      ];
      try {
        listed = [
          session({
            id: "codex:docs",
            title: "Docs work",
            scopeKind: "space",
            spaceId: "docs",
            spacePath: "/project/docs",
          }),
        ];
        await mountPeek("/project", {
          sessionId: "codex:docs",
          launchId: null,
        });
        const bar = document.querySelector("[data-peek-top-bar]")!;
        const changes = bar.querySelector("[data-changes-trigger]")!;
        const expand = bar.querySelector(`[aria-label="${m.peek_expand()}"]`)!;
        expect(changes.getAttribute("aria-label")?.includes("Docs")).toBe(true);
        expect(
          Boolean(
            changes.compareDocumentPosition(expand) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ).toBe(true);
      } finally {
        spaceState.spaces = [];
      }
    },
  );

  peekTest(
    "the session peek top bar has Open with, then icon-only Expand and Close, and no empty menu",
    async () => {
      listed = [session({ id: "codex:bar", title: "Bar" })];
      const { openChanges } = await mountPeek("/p-bar", {
        sessionId: "codex:bar",
        launchId: null,
      });
      const bar = document.querySelector("[data-peek-top-bar]")!;
      // Without a Routine or a running terminal the ⋯ has nothing to offer.
      expect(
        bar.querySelector(`[aria-label="${m.sessions_action_more()}"]`),
      ).toBeNull();
      const openWith = bar.querySelector(
        `[aria-label="${m.external_open_with()}"]`,
      )!;
      const expand = bar.querySelector(`[aria-label="${m.peek_expand()}"]`)!;
      const close = bar.querySelector(`[aria-label="${m.peek_close()}"]`)!;
      expect([openWith, expand, close].every(Boolean)).toBe(true);
      expect(
        Boolean(
          openWith.compareDocumentPosition(expand) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect(
        Boolean(
          expand.compareDocumentPosition(close) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect(expand.textContent).toBe("");
      await click(close);
      expect(openChanges).toEqual([false]);
    },
  );

  peekTest("the new session draft peek: New session on the left, Close on the right", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    mounted.push(root);
    const openChanges: boolean[] = [];
    await act(async () => {
      root.render(
        <TooltipProvider>
          <AgentSessionPeek
            target={null}
            draft={{ draftId: "draft-1", spacePath: "/p-draft" }}
            onOpenChange={(open) => openChanges.push(open)}
            onExpand={async () => true}
            onOpenRoutine={() => undefined}
          />
        </TooltipProvider>,
      );
    });
    await settle();
    const bar = document.querySelector<HTMLElement>("[data-peek-top-bar]")!;
    expect(
      bar.querySelector("[data-peek-identity]")?.textContent,
    ).toBe(m.sessions_new_title());
    expect(
      [...bar.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([m.peek_close()]);
    // The draft starts no terminal of its own.
    expect(
      [...document.querySelectorAll("button")].some((button) =>
        /terminal/i.test(button.textContent ?? ""),
      ),
    ).toBe(false);
    await click(buttonByLabel(m.peek_close()));
    expect(openChanges).toEqual([false]);
  });

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
      writeComposerDraft(sessionDraftKey("codex:read"), {
        parts: [{ type: "text", text: "Continue" }],
      });
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
    "attachments reach the agent as links where they were written, and a replayed link is a badge again",
    async () => {
      const key = { agent: "codex", namespace: "native", sessionId: "files" };
      listed = [
        session({
          id: "codex:files",
          title: "Files",
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openings.length = 0;
      prompts.length = 0;
      openedAttachments.length = 0;
      missingPaths.clear();
      missingPaths.add("/project/gone.md");
      snapshotWriter = "acp";
      openingOutcome = () => ({
        outcome: "opened",
        session: key,
        liveness: "free",
      });
      replayedMessage =
        "See [@plan.md](file:///project/plan.md) and [@gone.md](file:///project/gone.md)";
      writeComposerDraft(sessionDraftKey("codex:files"), {
        parts: [
          { type: "text", text: "Compare " },
          {
            type: "attachment",
            attachment: { path: "/project/notes.md", name: "Notes" },
          },
          { type: "text", text: " please" },
        ],
      });
      try {
        await mountPeek("/p-files", { sessionId: "codex:files", launchId: null });

        // The replayed links are badges; the one whose file is gone is marked
        // and opens nothing.
        await click(buttonByLabel("plan.md"));
        expect(openedAttachments).toEqual(["/project/plan.md"]);
        await click(
          buttonByLabel(
            m.sessions_chat_attachment_unavailable_label({ name: "gone.md" }),
          ),
        );
        expect(openedAttachments).toEqual(["/project/plan.md"]);
        expect(document.body.textContent?.includes("[@plan.md]")).toBe(false);

        // The draft's badge sits in the field and goes as a link in place.
        expect(buttonByLabel("Notes") !== null).toBe(true);
        await click(buttonByLabel(m.sessions_chat_send()));
        expect(prompts).toEqual([
          [
            { type: "text", text: "Compare " },
            { type: "file", path: "/project/notes.md", name: "Notes" },
            { type: "text", text: " please" },
          ],
        ]);
      } finally {
        replayedMessage = "Earlier";
        missingPaths.clear();
      }
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

      // The chat is the primary action of a session in its terminal.
      await expectPrimaryUnavailable(
        m.sessions_action_open_in_chat(),
        m.sessions_open_in_chat_terminal_live(),
      );
      await openOpenWith();
      const item = continuationItem("chat");
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

    await expectPrimaryUnavailable(
      m.sessions_action_open_in_svode_terminal(),
      m.sessions_chat_terminal_during_turn(),
    );
    await openOpenWith();
    const item = continuationItem("svode-terminal");
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

      await openOpenWith();
      await click(continuationItem("svode-terminal"));
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
      await openOpenWith();
      const item = continuationItem("svode-terminal");
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

      // "Chat" tries the chat again.
      await openOpenWith();
      await click(continuationItem("chat"));
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

  peekTest(
    "an IDE chat says to continue it in the IDE, and its Chat is unavailable with that reason",
    async () => {
      listed = [
        session({
          id: "cursor:ide:c1",
          source: "cursor",
          title: "IDE chat",
          status: {
            state: "unknown",
            source: "none",
            confidence: "approximate",
          },
          resumeCommand: undefined,
          capabilities: {
            canResume: false,
            canOpenInChat: false,
            continuesInIde: true,
          },
        }),
      ];
      openings.length = 0;
      await mountPeek("/p-ide", { sessionId: "cursor:ide:c1", launchId: null });

      expect(openings).toEqual([]);
      const reason = document.querySelector("[data-slot='marker']");
      // The test reads no agent registry, so the agent has the unknown label.
      expect(reason?.textContent).toBe(
        m.sessions_chat_unavailable_continues_in_ide({
          agent: m.agent_adapter_unknown(),
        }),
      );
      expect(
        Boolean(buttonByText(m.sessions_action_continue_in_terminal())),
      ).toBe(false);
      const ideReason = m.sessions_chat_unavailable_continues_in_ide({
        agent: m.agent_adapter_unknown(),
      });
      await expectPrimaryUnavailable(m.sessions_action_open_in_chat(), ideReason);
      await openOpenWith();
      const chat = continuationItem("chat");
      expect(chat?.getAttribute("aria-disabled")).toBe("true");
      expect(chat?.textContent?.includes(ideReason)).toBe(true);
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

      await pressEscape(buttonByLabel(m.external_open_with()));
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

  peekTest(
    "a Routine's terminal says why it is not the chat, for each reason, in en and ru",
    async () => {
      const original = getLocale();
      const reasons = [
        ["chat_unavailable", () => m.sessions_routine_terminal_chat_unavailable()],
        ["binding_not_acp", () => m.sessions_routine_terminal_binding_not_acp()],
        ["acp_failed_before_prompt", () => m.sessions_routine_terminal_acp_failed()],
      ] as const;
      try {
        for (const locale of ["en", "ru"] as const) {
          await setLocale(locale, { reload: false });
          for (const [reason, text] of reasons) {
            const id = `codex:${locale}-${reason}`;
            listed = [
              session({
                id,
                title: "Routine in terminal",
                launchId: `launch-${locale}-${reason}`,
                runtime: { live: true, ptyId: `pty-${locale}-${reason}` },
              }),
            ];
            routineLinks = [
              routineLink(`launch-${locale}-${reason}`, id, {
                transport: "terminal",
                reason,
                detail: "codex declares no ACP effort none",
              }),
            ];
            await mountPeek(`/p-${locale}-${reason}`, {
              sessionId: id,
              launchId: `launch-${locale}-${reason}`,
            });

            expect(terminal()?.dataset.terminal).toBe(`pty-${locale}-${reason}`);
            expect(document.body.textContent?.includes(text())).toBe(true);
            expect(
              document.body.textContent?.includes(
                "codex declares no ACP effort none",
              ),
            ).toBe(true);
            for (const root of mounted.splice(0)) {
              await act(async () => root.unmount());
            }
            document.body.innerHTML = "";
          }
        }
        expect(String(m.sessions_routine_terminal_chat_unavailable())).toBe(
          "Рутина запущена в терминале: чат недоступен агенту",
        );
      } finally {
        routineLinks = [];
        await setLocale(original, { reload: false });
      }
    },
  );

  peekTest(
    "the reason leaves with the Routine's terminal",
    async () => {
      listed = [
        session({
          id: "codex:routine-ending",
          title: "Routine ending",
          launchId: "launch-ending",
          runtime: { live: true, ptyId: "pty-routine-ending" },
        }),
      ];
      routineLinks = [
        routineLink("launch-ending", "codex:routine-ending", {
          transport: "terminal",
          reason: "chat_unavailable",
          detail: null,
        }),
      ];
      try {
        await mountPeek("/p-routine-ending", {
          sessionId: "codex:routine-ending",
          launchId: "launch-ending",
        });
        expect(
          document.body.textContent?.includes(
            m.sessions_routine_terminal_chat_unavailable(),
          ),
        ).toBe(true);

        listed = [
          session({
            id: "codex:routine-ending",
            title: "Routine ending",
            launchId: "launch-ending",
          }),
        ];
        await act(async () => exitListener?.("pty-routine-ending"));
        await settle();

        expect(terminal()).toBeNull();
        expect(
          document.body.textContent?.includes(
            m.sessions_routine_terminal_chat_unavailable(),
          ),
        ).toBe(false);
      } finally {
        routineLinks = [];
      }
    },
  );

  peekTest(
    "no reason shows for a manual terminal or a Routine run without one",
    async () => {
      const reasons = [
        m.sessions_routine_terminal_chat_unavailable(),
        m.sessions_routine_terminal_binding_not_acp(),
        m.sessions_routine_terminal_acp_failed(),
      ];
      listed = [
        session({
          id: "codex:manual-terminal",
          title: "Manual terminal",
          runtime: { live: true, ptyId: "pty-manual" },
        }),
        session({
          id: "codex:old-routine",
          title: "Old routine",
          launchId: "launch-old",
          runtime: { live: true, ptyId: "pty-old" },
        }),
      ];
      routineLinks = [
        routineLink("launch-old", "codex:old-routine", {
          transport: "terminal",
          reason: null,
          detail: null,
        }),
      ];
      try {
        await mountPeek("/p-manual-terminal", {
          sessionId: "codex:manual-terminal",
          launchId: null,
        });
        expect(terminal()?.dataset.terminal).toBe("pty-manual");
        expect(
          reasons.some((text) => document.body.textContent?.includes(text)),
        ).toBe(false);
        for (const root of mounted.splice(0)) {
          await act(async () => root.unmount());
        }
        document.body.innerHTML = "";

        await mountPeek("/p-old-routine", {
          sessionId: "codex:old-routine",
          launchId: "launch-old",
        });
        expect(terminal()?.dataset.terminal).toBe("pty-old");
        expect(
          reasons.some((text) => document.body.textContent?.includes(text)),
        ).toBe(false);
      } finally {
        routineLinks = [];
      }
    },
  );

  peekTest(
    "a Routine link opens its ACP session in the chat, which names the Routine without a reason",
    async () => {
      const key = {
        agent: "codex",
        namespace: "native",
        sessionId: "routine-acp",
      } as const;
      listed = [
        session({
          id: "codex:routine-acp",
          title: "Routine over ACP",
          runtime: { live: true, acpSession: key },
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      // An ACP launch carries no launch id: the run names its session.
      routineLinks = [
        routineLink("launch-acp", "codex:routine-acp", { transport: "acp" }),
      ];
      openings.length = 0;
      snapshotWriter = "acp";
      snapshotTurn = "none";
      try {
        // "Open session" of the Routine addresses the run's launch.
        await mountPeek("/p-routine-acp", {
          sessionId: "codex:routine-acp",
          launchId: "launch-acp",
        });

        expect(openings).toEqual([]);
        expect(terminal()).toBeNull();
        expect(document.body.textContent?.includes("Earlier")).toBe(true);
        expect(
          [
            m.sessions_routine_terminal_chat_unavailable(),
            m.sessions_routine_terminal_binding_not_acp(),
            m.sessions_routine_terminal_acp_failed(),
          ].some((text) => document.body.textContent?.includes(text)),
        ).toBe(false);
        await openMenu();
        expect(menuTexts()).toEqual([m.sessions_action_open_routine()]);
      } finally {
        routineLinks = [];
      }
    },
  );

  peekTest(
    "the session peek top bar shows the agent, title and status · time, then the menu, Expand and Close",
    async () => {
      listed = [session({ id: "codex:identity", title: "Identity" })];
      await mountPeek("/p-identity", {
        sessionId: "codex:identity",
        launchId: null,
      });
      const bar = document.querySelector("[data-peek-top-bar]")!;
      const identity = bar.querySelector<HTMLElement>("[data-peek-identity]")!;
      expect(identity.textContent).toBe("Identity");
      // The agent's brand icon.
      expect(Boolean(identity.querySelector("img"))).toBe(true);
      const status = bar.querySelector<HTMLElement>("[data-session-status]")!;
      expect(status.textContent?.startsWith(m.sessions_status_done())).toBe(
        true,
      );
      expect(Boolean(status.querySelector("time"))).toBe(true);
      expect(
        bar.querySelector(`[aria-label="${m.sessions_action_more()}"]`),
      ).toBeNull();
      expectInOrder([
        identity,
        status,
        primaryButton(),
        buttonByLabel(m.external_open_with()),
        buttonByLabel(m.peek_expand()),
        buttonByLabel(m.peek_close()),
      ]);
      expectNoContentHeader("Identity");

      await click(status);
      const metadata = document.querySelector("[data-slot=popover-content]")!;
      for (const text of [
        m.sessions_metadata(),
        m.sessions_metadata_scope(),
        m.sessions_metadata_status_source(),
        "/project",
        "identity",
      ]) {
        expect(metadata.textContent?.includes(text)).toBe(true);
      }
      await pressEscape(metadata as HTMLElement);

      // The peek has the continuation group only, without the project.
      await openOpenWith();
      expect(openWithEntries()).toEqual([
        "chat",
        "terminal:terminal",
        "terminal:iterm2",
        "copy-resume-command",
      ]);
    },
  );

  peekTest(
    "a missing session is named a session in the peek, without status",
    async () => {
      listed = [];
      await mountPeek("/p-missing-identity", {
        sessionId: "codex:gone-identity",
        launchId: null,
      });
      const bar = document.querySelector("[data-peek-top-bar]")!;
      expect(bar.querySelector("[data-peek-identity]")?.textContent).toBe(
        m.sessions_peek_title(),
      );
      expect(bar.querySelector("[data-session-status]")).toBeNull();
      expect(bar.querySelector("[data-slot=skeleton]")).toBeNull();
    },
  );

  peekTest(
    "while the session is checked the peek identity waits as a skeleton",
    async () => {
      listed = [session({ id: "codex:checked", title: "Checked" })];
      let release = () => {};
      listGate = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await mountPeek("/p-checked", {
          sessionId: "codex:checked",
          launchId: null,
        });
        const bar = document.querySelector("[data-peek-top-bar]")!;
        expect(Boolean(bar.querySelector("[data-slot=skeleton]"))).toBe(true);
        expect(bar.querySelector("[data-peek-identity]")).toBeNull();
        expect(bar.querySelector("[data-session-status]")).toBeNull();
      } finally {
        listGate = null;
        release();
      }
      await settle();
      const bar = document.querySelector("[data-peek-top-bar]")!;
      expect(bar.querySelector("[data-peek-identity]")?.textContent).toBe(
        "Checked",
      );
      expect(bar.querySelector("[data-slot=skeleton]")).toBeNull();
    },
  );

  peekTest(
    "a session in the main area gives the top bar its identity, status and menu, and has no header of its own",
    async () => {
      listed = [
        session({
          id: "codex:main-chat",
          title: "Main chat",
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      openingOutcome = () => ({
        outcome: "opened",
        session: {
          agent: "codex",
          namespace: "native",
          sessionId: "main-chat",
        },
        liveness: "unknown",
      });
      snapshotWriter = "none";
      snapshotTurn = "none";
      try {
        await mountPeek(
          "/p-main-chat",
          { sessionId: "codex:main-chat", launchId: null },
          false,
          true,
        );
        const header =
          document.querySelector<HTMLElement>("[data-main-header]")!;
        expect(header.dataset.space).toBe("/project");
        const page = header.querySelector("[data-slot=breadcrumb-page]")!;
        expect(page.textContent).toBe("Main chat");
        expect(Boolean(page.querySelector("img"))).toBe(true);
        const status = header.querySelector<HTMLElement>(
          "[data-session-status]",
        )!;
        expect(
          header.querySelector(`[aria-label="${m.sessions_action_more()}"]`),
        ).toBeNull();
        expectInOrder([page, status, primaryButton()]);
        expectNoContentHeader("Main chat");
        // The chat shows the session.
        expect(document.body.textContent?.includes("Earlier")).toBe(true);

        await click(status);
        expect(
          document
            .querySelector("[data-slot=popover-content]")
            ?.textContent?.includes(m.sessions_metadata()),
        ).toBe(true);
        await pressEscape(
          document.querySelector<HTMLElement>("[data-slot=popover-content]")!,
        );

        // The continuation group leads, the project applications follow it.
        expect(primaryButton().getAttribute("aria-label")).toBe(
          m.sessions_action_open_in_svode_terminal(),
        );
        await openOpenWith();
        expect(openWithEntries()).toEqual([
          "svode-terminal",
          "terminal:terminal",
          "terminal:iterm2",
          "copy-resume-command",
          "separator",
          "app:file_manager",
          "app:terminal",
          "app:iterm2",
        ]);
      } finally {
        openingOutcome = () => ({ outcome: "unsupported" });
      }
    },
  );

  peekTest(
    "a session in its terminal keeps Close terminal in the main area menu",
    async () => {
      listed = [
        session({
          id: "codex:main-term",
          title: "Main terminal",
          runtime: { live: true, ptyId: "pty-main-term" },
        }),
      ];
      await mountPeek(
        "/p-main-term",
        { sessionId: "codex:main-term", launchId: null },
        false,
        true,
      );
      expect(terminal()?.dataset.terminal).toBe("pty-main-term");
      const header = document.querySelector("[data-main-header]")!;
      expect(
        header.querySelector("[data-slot=breadcrumb-page]")?.textContent,
      ).toBe("Main terminal");
      expect(Boolean(header.querySelector("[data-session-status]"))).toBe(true);
      expectNoContentHeader("Main terminal");

      await openMenu();
      expect(menuTexts()).toEqual([m.sessions_action_close_terminal()]);
    },
  );

  peekTest(
    "a Routine session keeps Open routine in the main area menu",
    async () => {
      const key = {
        agent: "codex",
        namespace: "native",
        sessionId: "main-routine",
      } as const;
      listed = [
        session({
          id: "codex:main-routine",
          title: "Main routine",
          runtime: { live: true, acpSession: key },
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      routineLinks = [
        routineLink("launch-main", "codex:main-routine", { transport: "acp" }),
      ];
      snapshotWriter = "acp";
      snapshotTurn = "none";
      try {
        await mountPeek(
          "/p-main-routine",
          { sessionId: "codex:main-routine", launchId: "launch-main" },
          false,
          true,
        );
        expect(
          document.querySelector(
            "[data-main-header] [data-slot=breadcrumb-page]",
          )?.textContent,
        ).toBe("Main routine");
        expectNoContentHeader("Main routine");
        await openMenu();
        expect(menuTexts()).toEqual([m.sessions_action_open_routine()]);
      } finally {
        routineLinks = [];
        snapshotWriter = "none";
      }
    },
  );

  peekTest(
    "Open with repeats the chosen external terminal after a restart; the pair takes it back",
    async () => {
      const key = {
        agent: "codex",
        namespace: "native",
        sessionId: "choice",
      } as const;
      listed = [
        session({
          id: "codex:choice",
          title: "Choice",
          runtime: { live: true, acpSession: key },
          capabilities: { canResume: true, canOpenInChat: true },
        }),
      ];
      snapshotWriter = "acp";
      snapshotTurn = "none";
      const copied: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => void copied.push(text) },
      });
      openedApps.length = 0;
      commands.length = 0;
      const target = { sessionId: "codex:choice", launchId: null };
      try {
        await mountPeek("/p-choice", target);
        expect(primaryButton().getAttribute("aria-label")).toBe(
          m.sessions_action_open_in_svode_terminal(),
        );

        // Copying the resume command never becomes primary.
        await openOpenWith();
        await click(continuationItem("copy-resume-command"));
        expect(copied).toEqual(["codex resume abc"]);
        expect(primaryButton().getAttribute("aria-label")).toBe(
          m.sessions_action_open_in_svode_terminal(),
        );

        // An external terminal opens the session cwd and becomes primary.
        await openOpenWith();
        await click(
          document.querySelector<HTMLElement>(
            "[data-session-terminal='iterm2']",
          )!,
        );
        expect(openedApps).toEqual([{ projectPath: "/project", app: "iterm2" }]);
        expect(primaryButton().getAttribute("aria-label")).toBe(
          m.external_open_in({ name: "iTerm2" }),
        );

        // The choice is kept on the device, also for the main area.
        for (const root of mounted.splice(0)) {
          await act(async () => root.unmount());
        }
        document.body.innerHTML = "";
        await mountPeek("/p-choice", target, false, true);
        expect(primaryButton().getAttribute("aria-label")).toBe(
          m.external_open_in({ name: "iTerm2" }),
        );
        await click(primaryButton());
        expect(openedApps).toEqual([
          { projectPath: "/project", app: "iterm2" },
          { projectPath: "/project", app: "iterm2" },
        ]);

        // Choosing the Svode terminal forgets it: the chat of the pair is primary.
        await openOpenWith();
        await click(continuationItem("svode-terminal"));
        expect(commands.includes("agent_sessions_reenter")).toBe(true);
        expect(terminal()?.dataset.terminal).toBe("pty-resume-codex:choice");
        expect(primaryButton().getAttribute("aria-label")).toBe(
          m.sessions_action_open_in_chat(),
        );
      } finally {
        snapshotWriter = "none";
        Reflect.deleteProperty(navigator, "clipboard");
      }
    },
  );

  peekTest(
    "a missing or checked session in the main area names itself or waits as a skeleton",
    async () => {
      listed = [];
      await mountPeek(
        "/p-main-missing",
        { sessionId: "codex:main-gone", launchId: null },
        false,
        true,
      );
      let header = document.querySelector<HTMLElement>("[data-main-header]")!;
      expect(header.dataset.space).toBe("/project");
      expect(
        header.querySelector("[data-slot=breadcrumb-page]")?.textContent,
      ).toBe(m.sessions_peek_title());
      expect(header.querySelector("[data-session-status]")).toBeNull();
      expect(
        document.body.textContent?.includes(m.sessions_missing_title()),
      ).toBe(true);
      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      document.body.innerHTML = "";

      listed = [session({ id: "codex:main-checked", title: "Main checked" })];
      let release = () => {};
      listGate = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await mountPeek(
          "/p-main-checked",
          { sessionId: "codex:main-checked", launchId: null },
          false,
          true,
        );
        header = document.querySelector<HTMLElement>("[data-main-header]")!;
        expect(Boolean(header.querySelector("[data-slot=skeleton]"))).toBe(
          true,
        );
        expect(header.querySelector("[data-slot=breadcrumb-page]")).toBeNull();
      } finally {
        listGate = null;
        release();
      }
      await settle();
      header = document.querySelector<HTMLElement>("[data-main-header]")!;
      expect(
        header.querySelector("[data-slot=breadcrumb-page]")?.textContent,
      ).toBe("Main checked");
    },
  );

  /** The session's own content repeats no title header. */
  function expectNoContentHeader(title: string) {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
    expect(headings.some((heading) => heading.textContent === title)).toBe(
      false,
    );
    expect(
      document.querySelector(
        "[data-agent-session-content] header, header:not([data-main-header])",
      ),
    ).toBeNull();
  }

  function expectInOrder(elements: Element[]) {
    for (let index = 1; index < elements.length; index += 1) {
      expect(
        Boolean(
          elements[index - 1].compareDocumentPosition(elements[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    }
  }

  function menuTexts() {
    return Array.from(document.querySelectorAll("[role='menuitem']")).map(
      (item) =>
        item.querySelector("span.flex")?.firstChild?.textContent?.trim() ??
        item.textContent?.trim() ??
        "",
    );
  }

  function routineLink(
    launchId: string,
    agentSessionId: string,
    launch: Record<string, unknown>,
  ) {
    return {
      launchId,
      agentSessionId,
      launch,
      routineId: `routine-${launchId}`,
      ownerKind: "space",
      spaceId: "docs",
      ownerPath: ".",
      name: "Nightly review",
      definitionPresent: true,
    };
  }

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

  function menuItem(text: string) {
    return Array.from(document.querySelectorAll("[role='menuitem']")).find(
      (item) => item.textContent?.trim() === text,
    ) as HTMLElement;
  }

  function primaryButton() {
    return document.querySelector<HTMLButtonElement>(
      "[data-external-open-primary]",
    )!;
  }

  async function openOpenWith() {
    const trigger = buttonByLabel(m.external_open_with());
    await act(async () => {
      trigger.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
  }

  function continuationItem(kind: string) {
    return (
      document.querySelector<HTMLElement>(
        `[data-session-continuation="${kind}"]`,
      ) ?? undefined
    );
  }

  /** The "Open with" menu in order: continuation entries, then the project. */
  function openWithEntries() {
    const menu = document.querySelector("[role='menu']")!;
    return Array.from(
      menu.querySelectorAll<HTMLElement>(
        "[data-session-continuation], [data-session-terminal], [data-open-with-group-separator], [data-external-app]",
      ),
    ).map(
      (entry) =>
        entry.dataset.sessionContinuation ??
        (entry.dataset.sessionTerminal
          ? `terminal:${entry.dataset.sessionTerminal}`
          : entry.dataset.externalApp
            ? `app:${entry.dataset.externalApp}`
            : "separator"),
    );
  }

  /** The primary action is disabled, and its tooltip names it and says why. */
  async function expectPrimaryUnavailable(label: string, reason: string) {
    const button = primaryButton();
    expect(button.getAttribute("aria-label")).toBe(label);
    expect(button.disabled).toBe(true);
    const wrapper = button.closest<HTMLElement>(
      "[data-external-open-primary-unavailable]",
    )!;
    await act(async () => {
      wrapper.focus();
    });
    await settle();
    const tooltip = document.querySelector("[data-slot=tooltip-content]");
    expect(tooltip?.textContent?.includes(label)).toBe(true);
    expect(tooltip?.textContent?.includes(reason)).toBe(true);
    await act(async () => {
      wrapper.blur();
    });
    await settle();
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
          segments: [],
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
