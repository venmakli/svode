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
    if (command === "list_project_openers") return [];
    if (command === "routines_resolve_launches") return [];
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
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
        status: "active",
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
      status: "done",
      activeFlags: [],
      statusSource: "fallback",
      statusConfidence: "weak",
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
        canRevealFile: true,
        hasReadableLog: true,
      },
      pinned: false,
      sourceMeta: {
        historyPresent: false,
        detailPresent: false,
        sessionIndexPresent: false,
        detailFileCount: 0,
        historyLineCount: 0,
        detailLineCount: 0,
        malformedLineCount: 0,
        functionCallCount: 0,
        notes: [],
      },
      ...overrides,
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
        pinnedSessions: 0,
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
