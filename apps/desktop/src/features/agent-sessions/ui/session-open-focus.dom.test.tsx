import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AgentSession as ListedAgentSession } from "../api";
import type { AgentSessionTarget } from "../model";

if (process.env.SVODE_SESSION_OPEN_FOCUS_DOM !== "1") {
  test("session open focus DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SESSION_OPEN_FOCUS_DOM: "1" },
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
    "<!doctype html><html><body></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  // Slate follows the page selection only in an editable field, as WebKit.
  Object.defineProperty(dom.window.HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true";
    },
  });
  // WebKit keeps a caret already placed in the field it focuses.
  const focus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    const selection = dom.window.document.getSelection();
    const caret =
      selection?.rangeCount && this.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    focus.call(this, options);
    if (caret) {
      selection!.removeAllRanges();
      selection!.addRange(caret);
    }
  };

  mock.module("@/features/terminal/session-surface", () => ({
    ManagedTerminalSurface: ({ ptyId }: { ptyId: string }) => (
      <div tabIndex={0} data-terminal={ptyId} />
    ),
    closeManagedTerminalSurface: async () => undefined,
    spawnManagedTerminalSurface: async () => ({ ptyId: "pty-new", cwd: "/project" }),
    usePanelTerminal: () => ({ inPanel: false, show: () => undefined }),
    subscribeManagedTerminalExit: () => () => undefined,
    registerAgentTerminalSession: async () => undefined,
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
    spaces: [],
  };
  mock.module("@/features/space", () => ({
    getSpaceSnapshot: () => spaceState,
    useSpace: (selector?: (state: typeof spaceState) => unknown) =>
      selector ? selector(spaceState) : spaceState,
  }));

  let listed: ListedAgentSession[] = [];
  /** Holds an opening in the chat back, as while its history loads. */
  let openingGate: Promise<void> | null = null;
  let openingOutcome: "opened" | "confirmation_required" = "opened";
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "agent_sessions_list":
      case "agent_sessions_refresh":
        return listResult(listed);
      case "agent_sessions_hot_status":
        return {
          generatedAt: "2026-10-16T10:00:00Z",
          projectPath: payload.projectPath,
          sessions: [],
          checkedSessions: 0,
          updatedSessions: 0,
          skippedSessions: 0,
          sources: [],
        };
      case "agent_runtime_open_session": {
        const outcome =
          openingOutcome === "opened"
            ? {
                outcome: "opened",
                session: { agent: "codex", namespace: "native", sessionId: "read" },
                liveness: "unknown",
              }
            : { outcome: "confirmation_required", turnOpen: false };
        return openingGate ? openingGate.then(() => outcome) : outcome;
      }
      case "agent_runtime_subscribe": {
        const channel = payload.channel as { id: number };
        setTimeout(() =>
          (
            window as unknown as {
              __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
            }
          ).__TAURI_INTERNALS__.runCallback(channel.id, {
            index: 0,
            message: { type: "snapshot", value: snapshot(payload.session) },
          }),
        );
        return 1;
      }
      case "agent_runtime_unsubscribe":
      case "agent_runtime_release_session":
        return null;
      case "path_exists":
        return true;
      case "list_project_openers":
        return [];
      case "agent_setup_chat_agents":
        return { agents: [], last: null };
      case "routines_resolve_launches":
        return [];
      case "git_status":
        throw new Error("not a repository");
    }
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime.js");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { useAgentSessionCatalogLifecycle } = await import("../hooks");
  const { requestComposerFocus } = await import("../chat/hooks/use-composer-focus");
  const { sessionDraftKey, writeComposerDraft } = await import("../chat/model/composer");
  const { AgentSessionPeek } = await import("./session-peek");
  const { AgentSessionMainSurface } = await import("./session-main-surface");

  type ComposerFocusRequest = ReturnType<typeof requestComposerFocus>;
  type Host =
    | { kind: "main"; focus: boolean; composerFocus?: ComposerFocusRequest | null }
    | { kind: "peek" };

  const FOLLOWED: AgentSessionTarget = { sessionId: "codex:followed", launchId: null };
  const READ: AgentSessionTarget = { sessionId: "codex:read", launchId: null };
  const CHATS = [
    ["followed", FOLLOWED],
    ["read", READ],
  ] as const;
  /** A sidebar row opens the session: the main area with the composer's request. */
  const fromRow = (): Host => ({
    kind: "main",
    focus: false,
    composerFocus: requestComposerFocus(),
  });

  function Harness({ target, host }: { target: AgentSessionTarget; host: Host }) {
    useAgentSessionCatalogLifecycle("/project");
    return (
      <TooltipProvider>
        {host.kind === "main" ? (
          <AgentSessionMainSurface
            target={target}
            focus={host.focus}
            composerFocus={host.composerFocus}
            onOpenRoutine={() => undefined}
            renderHeader={({ current }) => <div data-main-header>{current}</div>}
          />
        ) : (
          <AgentSessionPeek
            target={target}
            onOpenChange={() => undefined}
            onExpand={async () => true}
            onOpenRoutine={() => undefined}
          />
        )}
      </TooltipProvider>
    );
  }

  let root: Root | null = null;
  function focusTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      listed = [
        session("codex:followed", {
          runtime: {
            live: true,
            acpSession: { agent: "codex", namespace: "native", sessionId: "followed" },
          },
        }),
        session("codex:read"),
        session("codex:terminal", { runtime: { live: true, ptyId: "pty-1" } }),
      ];
      openingGate = null;
      openingOutcome = "opened";
      try {
        await fn();
      } finally {
        await act(async () => root?.unmount());
        root = null;
        document.body.innerHTML = "";
        window.sessionStorage.clear();
      }
    });
  }

  /** A sidebar row that holds focus, as one activated with Enter. */
  function focusedRow() {
    const row = document.createElement("button");
    row.textContent = "Row";
    document.body.append(row);
    row.focus();
    return row;
  }

  /** Shows `target` in `host`, mounting the host the first time. */
  async function show(target: AgentSessionTarget, host: Host) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(<Harness target={target} host={host} />);
    });
    await settle();
    await pastFocusRetries();
  }

  /** Past the retries the editor makes to take focus itself. */
  async function pastFocusRetries() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  }

  function field() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    );
  }

  /** Where focus is: in the composer, the peek, the main area surface or else. */
  function focusPlace() {
    const active = document.activeElement;
    if (!active || active === document.body) return "nowhere";
    if (field()?.contains(active)) return "composer";
    if (active.closest("[role=dialog]")) return "peek";
    if (active.getAttribute("tabindex") === "-1" && field() && active.contains(field())) {
      return "surface";
    }
    return active.textContent === "Row" ? "row" : active.tagName.toLowerCase();
  }

  /** The caret's offset in the field's text, or null without one inside it. */
  function caret() {
    const selection = document.getSelection();
    const element = field();
    if (!selection?.rangeCount || !element?.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return range.toString().length;
  }

  for (const [name, target] of CHATS) {
    focusTest(`a ${name} chat opened by a click on a sidebar row takes focus at the end of its draft`, async () => {
      writeComposerDraft(sessionDraftKey(target.sessionId), {
        parts: [{ type: "text", text: "Draft" }],
      });
      // A click leaves focus nowhere, as on a row in WKWebView.
      await show(target, fromRow());
      expect(focusPlace()).toBe("composer");
      expect(caret()).toBe("Draft".length);
    });

    focusTest(`a ${name} chat opened by Enter on a sidebar row takes focus from the row`, async () => {
      focusedRow();
      await show(target, fromRow());
      expect(focusPlace()).toBe("composer");
    });

    focusTest(`a ${name} chat opened without a request takes no focus, wherever focus is`, async () => {
      await show(target, { kind: "main", focus: false });
      expect(Boolean(field())).toBe(true);
      expect(focusPlace()).toBe("nowhere");
      await act(async () => root?.unmount());
      root = null;
      focusedRow();
      await show(target, { kind: "main", focus: false });
      expect(focusPlace()).toBe("row");
    });

    // Baseline before DF-176: Expand and the session peek keep their focus.
    focusTest(`Expand puts focus on the main area of a ${name} chat, not in its composer`, async () => {
      // Focus was in the peek Expand closes.
      focusedRow();
      await show(target, { kind: "main", focus: true });
      expect(focusPlace()).toBe("surface");
    });

    focusTest(`the peek of a ${name} chat keeps focus in its chrome`, async () => {
      // Opened from a row of the Sessions collection, which holds focus.
      focusedRow();
      await show(target, { kind: "peek" });
      expect(Boolean(field())).toBe(true);
      expect(focusPlace()).toBe("peek");
    });
  }

  focusTest("a request is carried out once; the next opening of the row asks again", async () => {
    const row = focusedRow();
    const host = fromRow();
    await show(FOLLOWED, host);
    expect(focusPlace()).toBe("composer");
    await act(async () => row.focus());
    await show(FOLLOWED, { ...host });
    expect(focusPlace()).toBe("row");
    await show(FOLLOWED, fromRow());
    expect(focusPlace()).toBe("composer");
  });

  focusTest("while the history loads, focus the user moved elsewhere stays there", async () => {
    let release!: () => void;
    openingGate = new Promise((resolve) => (release = resolve));
    focusedRow();
    await show(READ, fromRow());
    expect(Boolean(field())).toBe(false);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    await act(async () => elsewhere.focus());
    await act(async () => release());
    await settle();
    await pastFocusRetries();
    expect(Boolean(field())).toBe(true);
    expect(document.activeElement === elsewhere).toBe(true);
  });

  focusTest("the composer that appears once the history loads takes focus", async () => {
    let release!: () => void;
    openingGate = new Promise((resolve) => (release = resolve));
    focusedRow();
    await show(READ, fromRow());
    expect(Boolean(field())).toBe(false);
    await act(async () => release());
    await settle();
    await pastFocusRetries();
    expect(focusPlace()).toBe("composer");
  });

  focusTest("a session that asks to load its history first lets the request lapse", async () => {
    openingOutcome = "confirmation_required";
    await show(READ, fromRow());
    expect(Boolean(field())).toBe(false);
    openingOutcome = "opened";
    const load = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === m.sessions_chat_load_history(),
    )!;
    await act(async () => load.click());
    await settle();
    await pastFocusRetries();
    expect(Boolean(field())).toBe(true);
    expect(focusPlace()).toBe("nowhere");
  });

  focusTest("a session shown in its terminal leaves focus in the sidebar", async () => {
    focusedRow();
    await show({ sessionId: "codex:terminal", launchId: null }, fromRow());
    expect(Boolean(document.querySelector("[data-terminal]"))).toBe(true);
    expect(focusPlace()).toBe("row");
  });

  focusTest("a missing session leaves focus in the sidebar", async () => {
    focusedRow();
    await show({ sessionId: "codex:gone", launchId: null }, fromRow());
    expect(document.body.textContent?.includes(m.sessions_missing_title())).toBe(true);
    expect(focusPlace()).toBe("row");
  });

  function session(
    id: string,
    overrides: Partial<ListedAgentSession> = {},
  ): ListedAgentSession {
    return {
      id,
      source: "codex",
      sourceSessionId: id.replace(/^.+:/, ""),
      title: id,
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
      lastActivityAt: "2026-10-16T10:00:00Z",
      resumeCommand: {
        display: "codex resume abc",
        program: "codex",
        args: ["resume", "abc"],
        cwd: "/project",
      },
      capabilities: { canResume: true, canOpenInChat: true },
      ...overrides,
    };
  }

  function snapshot(session: unknown) {
    const followed =
      (session as { sessionId?: string } | null)?.sessionId === "followed";
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
      history: { source: "replay", available: true, truncatedItems: null },
      writer: followed ? "acp" : "none",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    };
  }

  function listResult(sessions: ListedAgentSession[]) {
    return {
      generatedAt: "2026-10-16T10:00:00Z",
      projectPath: "/project",
      status: "ok",
      cache: { mode: "fingerprint-hit", hit: true, sourceHits: 1, sourceMisses: 0 },
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
    InputEvent: dom.window.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
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
