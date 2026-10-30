import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentActivityItemDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
  AgentSessionStatusDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_REPLAY_FAILURE_DOM !== "1") {
  test("replay failure marker DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_REPLAY_FAILURE_DOM: "1" },
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
  ): AgentActivityItemDto {
    return {
      id,
      turnId,
      status: "completed",
      summary,
      hasDetail: false,
      ...kind,
    } as AgentActivityItemDto;
  }

  /** A Codex session whose last turn the API refused, as its replay shows it. */
  const replay = [
    item("u1", "replay:1", { kind: "user_message", segments: [] }, "Hello"),
    item("m1", "replay:1", { kind: "agent_message", media: [] }, "Hi"),
    item("u2", "replay:2", { kind: "user_message", segments: [] }, "Oscar"),
  ];

  const failed: AgentSessionStatusDto = {
    state: "idle",
    stopReason: "error",
    source: "native_status_reader",
    confidence: "approximate",
  };

  function snapshot(
    items: AgentActivityItemDto[],
    turn: { turnId: string | null; phase: "none" | "running" } = {
      turnId: null,
      phase: "none",
    },
  ): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        ...turn,
        lastOutcome: null,
        status: { state: "unknown", source: "none", confidence: "approximate" },
      },
      items,
      pending: null,
      history: { source: "replay", available: true, truncatedItems: null },
      writer: "acp",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    } as unknown as AgentSessionSnapshotDto;
  }

  let root: Root | null = null;
  async function render(
    value: AgentSessionSnapshotDto,
    status: AgentSessionStatusDto | null,
  ) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    const target = root;
    await act(async () => {
      target.render(
        <TooltipProvider>
          <ChatTimeline session={key} snapshot={value} status={status} />
        </TooltipProvider>,
      );
    });
  }

  /** The rows of the timeline's text, in order. */
  const rows = () =>
    Array.from(
      document.querySelector("[data-slot='message-scroller-content']")
        ?.children ?? [],
    )
      .map((row) => row.textContent?.trim() ?? "")
      .filter(Boolean);
  const markers = () =>
    rows().filter((row) => row === m.sessions_chat_outcome_error());

  test("the replayed last turn shows the error marker by a failed status", async () => {
    try {
      await render(snapshot(replay), failed);
      expect(rows()).toEqual([
        "Hello",
        "Hi",
        "Oscar",
        m.sessions_chat_outcome_error(),
      ]);
    } finally {
      await unmount();
    }
  });

  test("an ended status or the runtime's own outcome adds no marker", async () => {
    try {
      await render(snapshot(replay), { ...failed, stopReason: "end_turn" });
      expect(markers()).toEqual([]);
      await render(snapshot(replay), null);
      expect(markers()).toEqual([]);
      await render(
        snapshot([
          ...replay,
          item("o2", "replay:2", {
            kind: "turn_outcome",
            reason: "error",
            durationMs: 5,
          }),
        ]),
        failed,
      );
      expect(markers()).toEqual([m.sessions_chat_outcome_error()]);
    } finally {
      await unmount();
    }
  });

  test("a new turn takes the marker away", async () => {
    try {
      await render(snapshot(replay), failed);
      expect(markers()).toEqual([m.sessions_chat_outcome_error()]);
      const next = [
        ...replay,
        item("u3", "t1", { kind: "user_message", segments: [] }, "Again"),
      ];
      await render(snapshot(next, { turnId: "t1", phase: "running" }), failed);
      expect(markers()).toEqual([]);
      await render(
        snapshot(
          [
            ...next,
            item("m3", "t1", { kind: "agent_message", media: [] }, "oscar"),
            item("o3", "t1", {
              kind: "turn_outcome",
              reason: "end_turn",
              durationMs: 5,
            }),
          ],
          { turnId: "t1", phase: "none" },
        ),
        { ...failed, stopReason: "end_turn", source: "svode_runtime" },
      );
      expect(markers()).toEqual([]);
    } finally {
      await unmount();
    }
  });

  async function unmount() {
    const target = root;
    root = null;
    if (target) await act(async () => target.unmount());
    document.body.innerHTML = "";
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
