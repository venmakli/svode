import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentSession as ListedAgentSession } from "../api";
import type { AgentSessionTarget } from "../model";

if (process.env.SVODE_AGENT_SESSIONS_SURFACE_DOM !== "1") {
  test("sessions collection DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_SESSIONS_SURFACE_DOM: "1" },
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

  const spawned: string[] = [];
  mock.module("@/features/terminal/session-surface", () => ({
    ManagedTerminalSurface: () => null,
    usePanelTerminal: () => ({ inPanel: false, show: () => undefined }),
    closeManagedTerminalSurface: async () => undefined,
    spawnManagedTerminalSurface: async (cwd: string) => {
      spawned.push(cwd);
      return { ptyId: "pty-new", cwd };
    },
    subscribeManagedTerminalExit: () => () => undefined,
  }));
  mock.module("@/features/external-open", () => ({
    ExternalAppIcon: () => null,
  }));
  const spaceState = {
    activeRootIcon: null,
    activeRootId: "root",
    activeRootName: "Project",
    activeRootPath: "/project",
    spaces: [
      {
        id: "docs",
        name: "Docs",
        icon: "",
        path: "/project/docs",
        status: "ready",
      },
    ],
  };
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  let listed: ListedAgentSession[] = [];
  let listStatus: "ok" | "partial" = "ok";
  let chatAgents: { agent: string; name: string; offer: { state: string } }[] =
    [];
  const commands: string[] = [];
  const resolvedLaunches: string[][] = [];
  const releasedHolds: number[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, payload) => {
    commands.push(command);
    if (command === "routines_resolve_launches") {
      resolvedLaunches.push([
        ...(payload as { launchIds: string[] }).launchIds,
      ]);
      return [
        {
          launchId: "launch-docs",
          routineId: "routine-docs",
          ownerKind: "space",
          spaceId: "docs",
          ownerPath: ".",
          name: "Docs sync",
          definitionPresent: true,
        },
      ];
    }
    if (command.startsWith("plugin:event|")) return 1;
    if (
      command === "agent_sessions_list" ||
      command === "agent_sessions_refresh"
    ) {
      return listResult(listed, listStatus);
    }
    if (command === "agent_sessions_hot_status") {
      return {
        generatedAt: "2026-09-29T10:00:00Z",
        projectPath: "/project",
        sessions: [],
        checkedSessions: 0,
        updatedSessions: 0,
        skippedSessions: 0,
        sources: [],
      };
    }
    if (command === "agent_adapters_list_identities") {
      return [
        { id: "codex", displayName: "Codex" },
        { id: "claude-code", displayName: "Claude Code" },
      ];
    }
    if (command === "list_project_openers") return [];
    if (command === "agent_sessions_hold_catalog") return 7;
    if (command === "agent_sessions_release_catalog") {
      releasedHolds.push((payload as { hold: number }).hold);
      return undefined;
    }
    if (command === "agent_sessions_raise_catalog") return undefined;
    if (command === "agent_setup_chat_agents") {
      return { agents: chatAgents, last: null };
    }
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { createRegisteredSpaceOwner } =
    await import("@/features/scope-surfaces");
  const { useAgentSessionCatalogLifecycle } = await import("../hooks");
  const { AgentSessionsSurface } = await import("./sessions-surface");

  const opened: AgentSessionTarget[] = [];
  const drafts: { spacePath: string }[] = [];
  const openedWithFocus: boolean[] = [];
  let settingsOpened = 0;

  function Harness({
    spacePath,
    spaceId,
  }: {
    spacePath: string;
    spaceId: string;
  }) {
    useAgentSessionCatalogLifecycle("/project");
    return (
      <TooltipProvider>
        <AgentSessionsSurface
          owner={createRegisteredSpaceOwner({
            spaceId,
            spacePath,
            projectPath: "/project",
            status: "ready",
            hasSchema: false,
          })}
          presentation="full"
          onOpenSession={(target, options) => {
            opened.push(target);
            openedWithFocus.push(Boolean(options?.focusTerminal));
          }}
          onOpenNewSessionDraft={(draft) => drafts.push(draft)}
          onOpenAppSettings={() => {
            settingsOpened += 1;
          }}
          onOpenRoutine={() => undefined}
        />
      </TooltipProvider>
    );
  }

  const mounted: Root[] = [];
  function surfaceTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      opened.length = 0;
      drafts.length = 0;
      chatAgents = [];
      resolvedLaunches.length = 0;
      openedWithFocus.length = 0;
      commands.length = 0;
      releasedHolds.length = 0;
      spawned.length = 0;
      listStatus = "ok";
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

  async function mountSurface(spacePath: string, spaceId: string) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(<Harness spacePath={spacePath} spaceId={spaceId} />);
    });
    await settle();
  }

  listed = [
    session({ id: "codex:root", title: "Root work" }),
    session({
      id: "claude-code:docs",
      source: "claude-code",
      title: "Docs work",
      launchId: "launch-docs",
      scopeKind: "space",
      spaceId: "docs",
      spacePath: "/project/docs",
    }),
  ];

  surfaceTest("each Space lists only its own sessions", async () => {
    await mountSurface("/project", "root");
    expect(row("codex:root") === null).toBe(false);
    expect(row("claude-code:docs")).toBeNull();
    expect(row("codex:root")?.textContent.includes("Codex")).toBe(true);
    expect(commands.includes("agent_sessions_list")).toBe(true);

    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    await mountSurface("/project/docs", "docs");
    expect(row("codex:root")).toBeNull();
    expect(row("claude-code:docs")?.textContent.includes("Claude Code")).toBe(
      true,
    );
  });

  surfaceTest(
    "an open collection holds the agent catalogue until it closes",
    async () => {
      await mountSurface("/project", "root");
      expect(
        commands.filter((command) => command === "agent_sessions_hold_catalog"),
      ).toEqual(["agent_sessions_hold_catalog"]);
      expect(commands.includes("agent_sessions_raise_catalog")).toBe(false);

      for (const root of mounted.splice(0)) {
        await act(async () => root.unmount());
      }
      await settle();
      expect(releasedHolds).toEqual([7]);
    },
  );

  surfaceTest(
    "a Routine launch shows its routine, read from the Routines owner by launch id",
    async () => {
      await mountSurface("/project/docs", "docs");

      expect(resolvedLaunches).toEqual([["launch-docs"]]);
      expect(row("claude-code:docs")?.textContent.includes("Docs sync")).toBe(
        true,
      );
    },
  );

  surfaceTest(
    "activating a row opens its session without resuming it",
    async () => {
      await mountSurface("/project/docs", "docs");
      const title = Array.from(
        row("claude-code:docs")!.querySelectorAll("span"),
      ).find((element) => element.textContent === "Docs work")!;
      await act(async () => {
        title.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await settle();

      expect(opened).toEqual([
        { sessionId: "claude-code:docs", launchId: "launch-docs" },
      ]);
      expect(openedWithFocus).toEqual([false]);
      expect(commands.includes("agent_sessions_reenter")).toBe(false);
    },
  );

  surfaceTest(
    "New session opens a chat draft in this Space when an agent can chat",
    async () => {
      chatAgents = [
        { agent: "codex", name: "Codex", offer: { state: "available" } },
      ];
      await mountSurface("/project/docs", "docs");
      await click(buttonByText(m.sessions_action_new()));

      expect(drafts.map((draft) => draft.spacePath)).toEqual([
        "/project/docs",
      ]);
      expect(spawned).toEqual([]);
      expect(opened).toEqual([]);
    },
  );

  surfaceTest(
    "New session without a chat agent starts a pending session in this Space and opens it",
    async () => {
      await mountSurface("/project/docs", "docs");
      await click(buttonByText(m.sessions_action_new()));

      expect(spawned).toEqual(["/project/docs"]);
      // Starting a session moves focus into its terminal.
      expect(openedWithFocus).toEqual([true]);
      expect(opened.length).toBe(1);
      expect(opened[0]?.launchId).toBeNull();
      expect(
        row(opened[0]!.sessionId)?.textContent.includes(m.sessions_new_title()),
      ).toBe(true);
    },
  );

  surfaceTest(
    "a partly unavailable source keeps rows and offers retry and settings",
    async () => {
      listStatus = "partial";
      await mountSurface("/project", "root");

      expect(row("codex:root") === null).toBe(false);
      expect(
        document.querySelector("[data-collection-diagnostics]"),
      ).toBeNull();
      await click(diagnosticsTrigger());
      await click(buttonByText(m.sessions_action_open_settings()));
      expect(settingsOpened).toBe(1);
      expect(
        document.querySelector("[data-sessions-diagnostics-dialog]"),
      ).toBeNull();
      await click(diagnosticsTrigger());
      const lists = commands.filter(
        (command) => command === "agent_sessions_refresh",
      ).length;
      await click(buttonByText(m.sessions_action_retry()));
      expect(
        commands.filter((command) => command === "agent_sessions_refresh")
          .length,
      ).toBe(lists + 1);
      // An explicit refresh starts the connections the collection needs.
      expect(
        commands.filter((command) => command === "agent_sessions_raise_catalog"),
      ).toEqual(["agent_sessions_raise_catalog"]);
    },
  );

  function row(id: string) {
    return document.querySelector<HTMLElement>(
      `[data-collection-row="${CSS.escape(id)}"]`,
    );
  }

  function diagnosticsTrigger() {
    return (
      document.querySelector<HTMLElement>("[data-sessions-diagnostics]") ??
      undefined
    );
  }

  function buttonByText(text: string) {
    return Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;
  }

  async function click(element: Element | undefined) {
    if (!element) throw new Error("element not found");
    await act(async () => {
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
      capabilities: {
        canResume: true,
        canOpenInChat: false,
      },
      ...overrides,
    };
  }

  function listResult(
    sessions: ListedAgentSession[],
    status: "ok" | "partial",
  ) {
    return {
      generatedAt: "2026-09-29T10:00:00Z",
      projectPath: "/project",
      status,
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
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    localStorage: dom.window.localStorage,
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
