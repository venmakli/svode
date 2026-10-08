import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentActivityItemDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_LIVE_TURN_MARKER_DOM !== "1") {
  test("live turn marker DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_LIVE_TURN_MARKER_DOM: "1" },
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
  const { createRoot } = await import("react-dom/client");
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command) => {
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ChatTimeline } = await import("./chat-timeline");

  const key: AgentSessionKeyDto = {
    agent: "codex",
    namespace: "native",
    sessionId: "s1",
  };

  function item(
    id: string,
    turnId: string,
    kind: Record<string, unknown>,
    summary = "",
    status: AgentActivityItemDto["status"] = "completed",
  ): AgentActivityItemDto {
    return {
      id,
      turnId,
      status,
      summary,
      hasDetail: false,
      ...kind,
    } as AgentActivityItemDto;
  }

  const read = (
    id: string,
    turnId: string,
    path: string,
    status = "in_progress",
  ) =>
    item(
      id,
      turnId,
      {
        kind: "tool_call",
        tool: "read",
        media: [],
        locations: [{ path, change: null, lines: null }],
        mcpCalls: [],
      },
      `Read ${path}`,
      status as AgentActivityItemDto["status"],
    );

  const firstTurn = [
    item("u1", "t1", { kind: "user_message", segments: [] }, "Hello"),
    item("m1", "t1", { kind: "agent_message", media: [] }, "Hi"),
    item("o1", "t1", {
      kind: "turn_outcome",
      reason: "end_turn",
      durationMs: 1000,
    }),
  ];

  function snapshot(
    items: AgentActivityItemDto[],
    phase: "none" | "running" | "cancelling",
  ): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        turnId: phase === "none" && items === firstTurn ? "t1" : "t2",
        phase,
        lastOutcome: null,
        status: {
          state: "running",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items,
      pending: null,
      history: { source: "live", available: true, truncatedItems: null },
      writer: "acp",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    } as unknown as AgentSessionSnapshotDto;
  }

  let root: Root | null = null;
  const restore: (() => void)[] = [];
  async function render(value: AgentSessionSnapshotDto) {
    const target = rootOf();
    await act(async () => {
      target.render(
        <TooltipProvider>
          <ChatTimeline session={key} snapshot={value} />
        </TooltipProvider>,
      );
    });
    await settle();
  }

  /**
   * Renders as a runtime update does, outside `act`: React commits and
   * runs effects in separate tasks, and the scroller observes each commit.
   */
  async function update(value: AgentSessionSnapshotDto) {
    const target = rootOf();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    try {
      target.render(
        <TooltipProvider>
          <ChatTimeline session={key} snapshot={value} />
        </TooltipProvider>,
      );
      for (let index = 0; index < 3; index += 1) {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    }
  }

  function rootOf(): Root {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    return root;
  }

  const marker = () =>
    document.querySelector<HTMLElement>("[data-slot='marker'][role='status']");
  const caption = () =>
    marker()?.querySelector("[data-live-turn-caption]")?.textContent ?? null;
  /** The last row of the timeline. */
  const atLiveEdge = (element: HTMLElement) =>
    Array.from(
      document.querySelector("[data-slot='message-scroller-content']")!
        .children,
    )
      .filter((row) => !row.hasAttribute("data-message-scroller-spacer"))
      .at(-1)!
      .contains(element);
  const ended = () =>
    Array.from(document.querySelectorAll("[role='status']")).find(
      (element) =>
        element !== marker() && element.className.includes("sr-only"),
    )?.textContent;

  test("the marker shows a running turn from the send to its end", async () => {
    try {
      await render(snapshot(firstTurn, "none"));
      expect(marker()).toBe(null);
      expect(ended()).toBe("");

      // Sent: the user's message and the marker below it, as the last row.
      const sent = [
        ...firstTurn,
        item("u2", "t2", { kind: "user_message", segments: [] }, "Read a file"),
      ];
      await render(snapshot(sent, "running"));
      const shown = marker()!;
      expect(Boolean(shown)).toBe(true);
      expect(atLiveEdge(shown)).toBe(true);
      expect(caption()).toBe(m.sessions_chat_live_working());
      expect(shown.textContent?.includes(m.sessions_chat_live_started())).toBe(
        true,
      );
      expect(
        shown.textContent?.includes(
          m.sessions_chat_duration_seconds({ seconds: 0 }),
        ),
      ).toBe(true);
      // One line: a long caption ends with an ellipsis.
      expect(
        shown
          .querySelector("[data-live-turn-caption]")!
          .className.includes("truncate"),
      ).toBe(true);

      // The caption follows the agent in the same marker.
      const reading = [
        ...sent,
        read("r1", "t2", "/project/notes/weekly-dev-status.md"),
      ];
      await render(snapshot(reading, "running"));
      expect(marker()).toBe(shown);
      expect(caption()).toBe(
        m.sessions_chat_live_reading_file({ name: "weekly-dev-status.md" }),
      );
      expect(atLiveEdge(shown)).toBe(true);

      await render(snapshot(reading, "cancelling"));
      expect(caption()).toBe(m.sessions_chat_live_stopping());

      // The end of the turn removes it and is announced.
      const done = [
        ...sent,
        read("r1", "t2", "/project/notes/weekly-dev-status.md", "completed"),
        item("m2", "t2", { kind: "agent_message", media: [] }, "Done"),
        item("o2", "t2", {
          kind: "turn_outcome",
          reason: "end_turn",
          durationMs: 2000,
        }),
      ];
      await render(snapshot(done, "none"));
      expect(marker()).toBe(null);
      expect(ended()).toBe(m.sessions_chat_live_ended());
    } finally {
      await unmount();
    }
  });

  test("a failed or interrupted turn takes the marker away", async () => {
    try {
      const sent = [
        ...firstTurn,
        item("u2", "t2", { kind: "user_message", segments: [] }, "Go"),
        read("r1", "t2", "/project/a.md"),
      ];
      for (const outcome of [
        item("o2", "t2", {
          kind: "turn_outcome",
          reason: "error",
          durationMs: 10,
        }),
        item("o2", "t2", { kind: "interrupted", durationMs: null }),
      ]) {
        await render(snapshot(sent, "running"));
        expect(Boolean(marker())).toBe(true);
        await render(snapshot([...sent, outcome], "none"));
        expect(marker()).toBe(null);
      }
    } finally {
      await unmount();
    }
  });

  test("the marker does not move a timeline the user scrolled up", async () => {
    try {
      const sent = [
        ...firstTurn,
        item("u2", "t2", { kind: "user_message", segments: [] }, "Read"),
      ];
      await render(snapshot(sent, "running"));
      const viewport = document.querySelector<HTMLElement>(
        "[data-slot='message-scroller-viewport']",
      )!;
      const moves: unknown[] = [];
      viewport.scrollTo = ((options: unknown) => moves.push(options)) as never;
      // A long timeline scrolled to its top: rows reach far below the
      // viewport, which jsdom does not lay out.
      Object.defineProperty(viewport, "clientHeight", { value: 100 });
      const rect = window.Element.prototype.getBoundingClientRect;
      window.Element.prototype.getBoundingClientRect = function () {
        return this === viewport
          ? new window.DOMRect(0, 0, 600, 100)
          : new window.DOMRect(0, 0, 600, 1000);
      };
      restore.push(() => {
        window.Element.prototype.getBoundingClientRect = rect;
      });
      let top = 0;
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          moves.push(value);
          top = value;
        },
      });
      // The user scrolls up: the timeline stops following the end.
      await act(async () => {
        viewport.dispatchEvent(new window.Event("wheel", { bubbles: true }));
      });
      moves.length = 0;

      const reading = [...sent, read("r1", "t2", "/project/a.md")];
      await update(snapshot(reading, "running"));
      await update(
        snapshot([...reading, read("r2", "t2", "/project/b.md")], "running"),
      );
      await update(
        snapshot(
          [
            ...sent,
            read("r1", "t2", "/project/a.md", "completed"),
            read("r2", "t2", "/project/b.md", "completed"),
            item("m2", "t2", { kind: "agent_message", media: [] }, "Read both"),
            item("o2", "t2", {
              kind: "turn_outcome",
              reason: "end_turn",
              durationMs: 5,
            }),
          ],
          "none",
        ),
      );
      expect(moves).toEqual([]);
    } finally {
      await unmount();
    }
  });

  async function unmount() {
    for (const undo of restore.splice(0)) undo();
    const target = root;
    root = null;
    if (target) await act(async () => target.unmount());
    document.body.innerHTML = "";
  }

  async function settle() {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    // The marker leaves a frame after its turn.
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
  }
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    customElements: dom.window.customElements,
    DOMRect: dom.window.DOMRect,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
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
