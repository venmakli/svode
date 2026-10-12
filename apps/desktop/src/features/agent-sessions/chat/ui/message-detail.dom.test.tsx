import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentActivityItemDto,
  AgentDetailOutcomeDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_MESSAGE_DETAIL_DOM !== "1") {
  test("message detail DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_MESSAGE_DETAIL_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");

  const key: AgentSessionKeyDto = {
    agent: "claude-code",
    namespace: "native",
    sessionId: "s1",
  };
  /** How the runtime answers the next detail read of an item. */
  let answer: (itemId: string) => Promise<AgentDetailOutcomeDto> = () =>
    Promise.reject(new Error("no detail set"));
  const reads: string[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    if (command === "agent_runtime_detail") {
      const itemId = (args as { itemId: string }).itemId;
      reads.push(itemId);
      return answer(itemId);
    }
    throw new Error(`unexpected command ${command}`);
  });

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { ChatTimeline } = await import("./chat-timeline");

  const SUMMARY = "The answer starts here.";

  function text(value: string): AgentDetailOutcomeDto {
    return { outcome: "available", blocks: [{ type: "text", text: value }] };
  }

  /** The agent's message as a delta sends it: a new item, same summary. */
  function message(hasDetail = true): AgentActivityItemDto {
    return {
      id: "m1",
      turnId: "t1",
      status: "",
      summary: SUMMARY,
      hasDetail,
      kind: "agent_message",
      media: [],
    } as unknown as AgentActivityItemDto;
  }

  function snapshot(
    agentMessage: AgentActivityItemDto,
    live = true,
  ): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: live
        ? {
            turnId: "t1",
            phase: "running",
            lastOutcome: null,
            status: {
              state: "running",
              source: "svode_runtime",
              confidence: "exact",
            },
          }
        : {
            turnId: null,
            phase: "none",
            lastOutcome: "end_turn",
            status: {
              state: "idle",
              source: "svode_runtime",
              confidence: "exact",
            },
          },
      items: [
        {
          id: "user:t1",
          turnId: "t1",
          status: "completed",
          summary: "Explain",
          hasDetail: false,
          kind: "user_message",
          segments: [],
        },
        agentMessage,
        ...(live
          ? []
          : [
              {
                id: "outcome:t1",
                turnId: "t1",
                status: "completed",
                summary: "",
                hasDetail: false,
                kind: "turn_outcome",
                reason: "end_turn",
                durationMs: 3000,
              },
            ]),
      ],
      pending: null,
      history: { source: "live", available: true, truncatedItems: null },
      writer: "acp",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    } as unknown as AgentSessionSnapshotDto;
  }

  const mounted: Root[] = [];
  async function mount(first: AgentSessionSnapshotDto) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    const render = (value: AgentSessionSnapshotDto) =>
      act(async () => {
        root.render(
          <ThemeProvider theme="light" setTheme={() => {}}>
            <TooltipProvider>
              <ChatTimeline session={key} snapshot={value} />
            </TooltipProvider>
          </ThemeProvider>,
        );
      });
    await render(first);
    await wait(0);
    return { container, update: render };
  }

  async function unmountAll() {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.replaceChildren();
    reads.length = 0;
  }

  function shownText(container: Element): string {
    return container.querySelector("[data-markdown-reader]")?.textContent ?? "";
  }

  function paragraphs(container: Element): HTMLParagraphElement[] {
    return Array.from(
      container.querySelectorAll<HTMLParagraphElement>(
        "[data-markdown-reader] p",
      ),
    );
  }

  test("a streamed message follows its detail during a series of deltas and shows the last detail after it", async () => {
    try {
      let full = SUMMARY;
      answer = async () => text(full);
      const view = await mount(snapshot(message()));
      expect(shownText(view.container)).toBe(SUMMARY);

      // Deltas every 50 ms, faster than the refresh interval: the summary
      // stays, only the detail grows.
      let during = "";
      for (let index = 1; index <= 12; index += 1) {
        full += `\n\nParagraph ${index}.`;
        await view.update(snapshot(message()));
        await wait(50);
        if (index === 8) during = shownText(view.container);
      }
      expect(during.includes("Paragraph 1.")).toBe(true);
      expect(during.includes("Paragraph 12.")).toBe(false);
      // Reads follow the interval, not every delta.
      expect(reads.length < 10).toBe(true);

      const first = paragraphs(view.container)[0];
      await wait(400);
      expect(shownText(view.container).includes("Paragraph 12.")).toBe(true);

      // The finished blocks keep their nodes as the text grows and when the
      // turn ends.
      const before = paragraphs(view.container);
      expect(before[0]).toBe(first);
      await view.update(snapshot(message(), false));
      await wait(50);
      const after = paragraphs(view.container);
      expect(after.length).toBe(before.length);
      after.forEach((node, index) => expect(node).toBe(before[index]));
      expect(shownText(view.container).includes("Paragraph 12.")).toBe(true);
    } finally {
      await unmountAll();
    }
  });

  test("an earlier read answering late does not replace a later one", async () => {
    try {
      let call = 0;
      answer = async () => {
        call += 1;
        if (call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return text(`${SUMMARY} early`);
        }
        return text(`${SUMMARY} late`);
      };
      const view = await mount(snapshot(message()));
      await wait(300);
      await view.update(snapshot(message()));
      await wait(100);
      expect(shownText(view.container)).toBe(`${SUMMARY} late`);
      await wait(400);
      expect(call).toBe(2);
      expect(shownText(view.container)).toBe(`${SUMMARY} late`);
    } finally {
      await unmountAll();
    }
  });

  test("a message whose detail cannot be read is marked incomplete", async () => {
    try {
      answer = () => Promise.reject(new Error("runtime gone"));
      const view = await mount(snapshot(message()));
      await wait(50);
      expect(shownText(view.container)).toBe(SUMMARY);
      const mark = view.container.querySelector(
        "[data-agent-message-incomplete]",
      );
      expect(mark?.textContent).toBe(
        m.sessions_chat_message_incomplete({
          reason: m.sessions_chat_detail_error({ message: "runtime gone" }),
        }),
      );
    } finally {
      await unmountAll();
    }
  });

  test("a message within its summary is shown without a read or a mark", async () => {
    try {
      answer = () => Promise.reject(new Error("must not read"));
      const view = await mount(snapshot(message(false)));
      await view.update(snapshot(message(false)));
      await wait(300);
      expect(reads).toEqual([]);
      expect(shownText(view.container)).toBe(SUMMARY);
      expect(
        view.container.querySelector("[data-agent-message-incomplete]"),
      ).toBeNull();
    } finally {
      await unmountAll();
    }
  });

  async function wait(ms: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    customElements: dom.window.customElements,
    CSSStyleSheet: dom.window.CSSStyleSheet,
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
