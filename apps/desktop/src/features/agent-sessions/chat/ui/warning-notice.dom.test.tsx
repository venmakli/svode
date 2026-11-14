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

if (process.env.SVODE_WARNING_NOTICE_DOM !== "1") {
  test("warning notice DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_WARNING_NOTICE_DOM: "1" },
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
      status: null,
      summary,
      hasDetail: false,
      ...kind,
    } as AgentActivityItemDto;
  }

  const warning = (id: string, turnId: string, text: string) =>
    item(id, turnId, { kind: "warning" }, text);
  const ended = (id: string, turnId: string) =>
    item(id, turnId, {
      kind: "turn_outcome",
      reason: "end_turn",
      durationMs: 5,
    });

  /** The first turn of a Codex session, ended with a warning on the way. */
  const first = [
    item("u1", "t1", { kind: "user_message", segments: [] }, "Hello"),
    warning("w1", "t1", "Model metadata for `mock-model` not found."),
    item("m1", "t1", { kind: "agent_message", media: [] }, "Hi"),
    ended("o1", "t1"),
  ];
  /** A second turn whose agent warned twice the same way. */
  const second = [
    item("u2", "t2", { kind: "user_message", segments: [] }, "Again"),
    warning("w2", "t2", "Reconnecting... 1/5"),
    warning("w3", "t2", "Reconnecting... 1/5"),
  ];

  function snapshot(
    items: AgentActivityItemDto[],
    turn: { turnId: string | null; phase: "none" | "running" },
  ): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        ...turn,
        lastOutcome: turn.phase === "none" ? "end_turn" : null,
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
  async function render(value: AgentSessionSnapshotDto) {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    const target = root;
    await act(async () => {
      target.render(
        <TooltipProvider>
          <ChatTimeline session={key} snapshot={value} />
        </TooltipProvider>,
      );
    });
  }

  /** The rows of the timeline, in order. */
  const rows = () =>
    Array.from(
      document.querySelector("[data-slot='message-scroller-content']")
        ?.children ?? [],
    ).filter((row) => row.textContent?.trim());
  const texts = () => rows().map((row) => row.textContent?.trim() ?? "");

  test("a warning is a row titled Warning without the error colour that opens to its text", async () => {
    try {
      await render(
        snapshot([...first, ...second], { turnId: "t2", phase: "running" }),
      );
      const title = m.sessions_chat_notice_warning();
      const repeated = `${title}${m.sessions_chat_repeats({ count: 2 })}`;
      const shown = texts();
      expect(
        shown.slice(shown.indexOf("Again"), shown.indexOf("Again") + 2),
      ).toEqual(["Again", repeated]);
      const row = rows().find((candidate) =>
        candidate.textContent?.trim().startsWith(title),
      )!;
      expect(row.querySelector(".text-destructive")).toBe(null);
      expect(row.textContent).not.toContain("Reconnecting");

      const trigger = row.querySelector("button")!;
      await act(async () => {
        trigger.dispatchEvent(
          new window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(row.textContent).toContain("Reconnecting... 1/5");
      expect(row.querySelector(".text-destructive")).toBe(null);
    } finally {
      await unmount();
    }
  });

  test("a turn with only warnings is not failed in the rail or by an outcome marker", async () => {
    try {
      await render(
        snapshot([...first, ...second, ended("o2", "t2")], {
          turnId: "t2",
          phase: "none",
        }),
      );
      expect(texts()).not.toContain(m.sessions_chat_outcome_error());
      const rail = document.querySelector<HTMLElement>(
        `nav[aria-label='${m.sessions_chat_turns()}']`,
      )!;
      const ticks = Array.from(
        rail.querySelectorAll<HTMLElement>("[data-active]"),
      ).map((tick) => tick.getAttribute("data-state"));
      expect(ticks).toEqual(["done", "done"]);
      expect(rail.textContent).not.toContain(m.sessions_chat_turn_failed());
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
