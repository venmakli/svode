import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentActivityItemDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_TURN_RAIL_DOM !== "1") {
  test("turn rail DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TURN_RAIL_DOM: "1" },
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

  /** Finished turns of a user's message and a reply: two rows each. */
  function turns(count: number): AgentActivityItemDto[] {
    return Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return [
        item(
          `u${n}`,
          `t${n}`,
          { kind: "user_message", segments: [] },
          `Ask ${n}`,
        ),
        item(
          `m${n}`,
          `t${n}`,
          { kind: "agent_message", media: [] },
          `Reply ${n}`,
        ),
        item(`o${n}`, `t${n}`, {
          kind: "turn_outcome",
          reason: "end_turn",
          durationMs: 10,
        }),
      ];
    }).flat();
  }

  function snapshot(
    items: AgentActivityItemDto[],
    history: Partial<AgentSessionSnapshotDto["history"]> = {},
  ): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        turnId: null,
        phase: "none",
        lastOutcome: null,
        status: {
          state: "idle",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items,
      pending: null,
      history: {
        source: "live",
        available: true,
        truncatedItems: null,
        ...history,
      },
      writer: "acp",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    } as unknown as AgentSessionSnapshotDto;
  }

  let root: Root | null = null;
  const restore: (() => void)[] = [];
  const moves: number[] = [];
  let top = 0;

  function view(value: AgentSessionSnapshotDto, header?: ReactNode) {
    return (
      <TooltipProvider>
        <ChatTimeline session={key} snapshot={value} header={header} />
      </TooltipProvider>
    );
  }

  /**
   * jsdom does not lay out: every row of the timeline is 100px tall in
   * order, in a viewport 100px tall that scrolls them. Installed before the
   * first render, so the timeline opens at its end.
   */
  function layOut() {
    const isViewport = (element: Element) =>
      element.getAttribute("data-slot") === "message-scroller-viewport";
    const rows = () =>
      Array.from(
        document.querySelector("[data-slot='message-scroller-content']")
          ?.children ?? [],
      ).filter((row) => !row.hasAttribute("data-message-scroller-spacer"));
    const proto = window.HTMLElement.prototype;
    const define = (name: string, descriptor: PropertyDescriptor) => {
      Object.defineProperty(proto, name, { configurable: true, ...descriptor });
      restore.push(() => {
        delete (proto as unknown as Record<string, unknown>)[name];
      });
    };
    define("clientHeight", {
      get(this: HTMLElement) {
        return isViewport(this) ? 100 : 0;
      },
    });
    define("scrollHeight", {
      get(this: HTMLElement) {
        return isViewport(this) ? rows().length * 100 : 0;
      },
    });
    define("scrollTop", {
      get(this: HTMLElement) {
        return isViewport(this) ? top : 0;
      },
      set(this: HTMLElement, value: number) {
        if (isViewport(this)) top = value;
      },
    });
    define("scrollTo", {
      writable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        if (!isViewport(this)) return;
        moves.push(options.top ?? 0);
        top = options.top ?? 0;
        this.dispatchEvent(new window.Event("scroll"));
      },
    });
    const rect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      if (isViewport(this)) return new window.DOMRect(0, 0, 600, 100);
      const index = rows().indexOf(this);
      if (index !== -1) {
        return new window.DOMRect(0, index * 100 - top, 600, 100);
      }
      return new window.DOMRect(0, 0, 0, 0);
    };
    restore.push(() => {
      window.Element.prototype.getBoundingClientRect = rect;
    });
  }

  async function render(value: AgentSessionSnapshotDto, header?: ReactNode) {
    const target = rootOf();
    await act(async () => target.render(view(value, header)));
    await settle();
  }

  /** Renders as a runtime update does, outside `act`. */
  async function update(value: AgentSessionSnapshotDto) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    try {
      rootOf().render(view(value));
      await frames();
    } finally {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    }
  }

  async function scrollTo(value: number) {
    await act(async () => {
      top = value;
      viewportOf().dispatchEvent(new window.WheelEvent("wheel"));
      viewportOf().dispatchEvent(new window.Event("scroll"));
    });
    await settle();
  }

  function rootOf(): Root {
    if (!root) {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    return root;
  }

  const viewportOf = () =>
    document.querySelector<HTMLElement>(
      "[data-slot='message-scroller-viewport']",
    )!;
  const rail = () =>
    document.querySelector<HTMLElement>(
      `nav[aria-label='${m.sessions_chat_turns()}']`,
    );
  const rows = () =>
    Array.from(rail()?.querySelectorAll<HTMLElement>("[data-turn-row]") ?? []);
  const activeRow = () =>
    rail()?.querySelector<HTMLElement>("[aria-current='location']");
  const ticks = () =>
    Array.from(rail()?.querySelectorAll<HTMLElement>("[data-active]") ?? []);
  const toEnd = () =>
    document.querySelector<HTMLElement>(
      "[data-slot='message-scroller-button']",
    );
  /** Where the timeline puts the user's message of the turn: its row. */
  const rowTop = (messageId: string) =>
    Array.from(
      document.querySelector("[data-slot='message-scroller-content']")!
        .children,
    ).findIndex((row) => row.getAttribute("data-message-id") === messageId) *
    100;

  test("the rail shows from two turns, outside the scrolled content", async () => {
    try {
      await render(snapshot(turns(1)));
      expect(rail()).toBe(null);

      await render(snapshot(turns(2)));
      expect(Boolean(rail())).toBe(true);
      expect(viewportOf().contains(rail())).toBe(false);
      expect(rows().map((row) => row.textContent)).toEqual([
        "Ask 1Reply 1",
        "Ask 2Reply 2",
      ]);
    } finally {
      await unmount();
    }
  });

  test("thirty turns: twenty ticks with the active one, every turn listed", async () => {
    try {
      layOut();
      await render(snapshot(turns(30)));
      await scrollTo(rowTop("u8"));
      expect(activeRow()?.textContent).toBe("Ask 8Reply 8");
      expect(ticks().length).toBe(20);
      expect(
        ticks().filter((tick) => tick.getAttribute("data-active") === "true")
          .length,
      ).toBe(1);
      expect(rows().length).toBe(30);
    } finally {
      await unmount();
    }
  });

  test("the active turn follows the scroll", async () => {
    try {
      layOut();
      await render(snapshot(turns(5)));
      await scrollTo(0);
      expect(activeRow()?.textContent).toBe("Ask 1Reply 1");
      // The user's message of the third turn passes the top.
      await scrollTo(rowTop("u3") + 30);
      expect(activeRow()?.textContent).toBe("Ask 3Reply 3");
      // Its reply fills the view: still the third turn.
      await scrollTo(rowTop("u3") + 100);
      expect(activeRow()?.textContent).toBe("Ask 3Reply 3");
      await scrollTo(rowTop("u4"));
      expect(activeRow()?.textContent).toBe("Ask 4Reply 4");
    } finally {
      await unmount();
    }
  });

  test("going to a turn leaves the end of the timeline", async () => {
    try {
      layOut();
      await render(snapshot(turns(5)));
      // Opened at the end, following it.
      expect(top).toBe(900);
      expect(toEnd()?.getAttribute("data-active")).toBe("false");

      moves.length = 0;
      await act(async () => rows()[1].click());
      await settle();
      expect(moves.at(-1)).toBe(rowTop("u2"));
      expect(activeRow()?.textContent).toBe("Ask 2Reply 2");
      expect(toEnd()?.getAttribute("data-active")).toBe("true");

      // New rows do not pull the timeline back to its end.
      moves.length = 0;
      await update(
        snapshot([
          ...turns(5),
          item("g1", null as never, { kind: "generic", label: "note" }, "x"),
        ]),
      );
      expect(moves).toEqual([]);
      expect(top).toBe(rowTop("u2"));
    } finally {
      await unmount();
    }
  });

  test("⌥↑ and ⌥↓ move one turn while focus is in the timeline, not in a field", async () => {
    try {
      layOut();
      await render(snapshot(turns(5)), <input aria-label="field" />);
      await scrollTo(rowTop("u3"));
      expect(activeRow()?.textContent).toBe("Ask 3Reply 3");

      const press = async (target: HTMLElement, key: string, altKey = true) => {
        moves.length = 0;
        await act(async () => {
          target.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              key,
              altKey,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await settle();
      };

      await press(viewportOf(), "ArrowUp");
      expect(moves.at(-1)).toBe(rowTop("u2"));
      expect(activeRow()?.textContent).toBe("Ask 2Reply 2");
      await press(viewportOf(), "ArrowDown");
      await press(viewportOf(), "ArrowDown");
      expect(moves.at(-1)).toBe(rowTop("u4"));
      expect(activeRow()?.textContent).toBe("Ask 4Reply 4");

      // Without ⌥ the arrows stay the scroller's.
      await press(viewportOf(), "ArrowUp", false);
      expect(activeRow()?.textContent).toBe("Ask 4Reply 4");

      // In a text field the keys are the field's.
      const field = document.querySelector<HTMLElement>(
        "input[aria-label='field']",
      )!;
      await press(field, "ArrowUp");
      expect(moves).toEqual([]);
      expect(activeRow()?.textContent).toBe("Ask 4Reply 4");

      // Outside the timeline nothing moves.
      const outside = document.createElement("textarea");
      document.body.append(outside);
      await press(outside, "ArrowUp");
      expect(moves).toEqual([]);
    } finally {
      await unmount();
    }
  });

  test("the list opens on focus at the active turn and marks running, stopped and failed turns", async () => {
    try {
      const items = [
        ...turns(2),
        item("u3", "t3", { kind: "user_message", segments: [] }, "Stop"),
        item("o3", "t3", {
          kind: "turn_outcome",
          reason: "cancelled",
          durationMs: 1,
        }),
        item("u4", "t4", { kind: "user_message", segments: [] }, "Fail"),
        item("o4", "t4", { kind: "interrupted", durationMs: null }),
      ];
      layOut();
      await render(snapshot(items, { truncatedItems: 12, truncatedTurns: 4 }));
      // Truncated history: the first row of the list, not a way to go.
      const first = rail()!.querySelector("ul > li")!;
      expect(first.textContent).toBe(
        m.sessions_chat_turns_hidden({ count: 4 }),
      );
      expect(first.querySelector("button")).toBe(null);
      // Opened at the end: the last turn is active.
      expect(activeRow()).toBe(rows()[3]);
      const texts = rows().map((row) => row.textContent);
      expect(texts.slice(2)).toEqual([
        `Stop${m.sessions_chat_turn_stopped()}`,
        `Fail${m.sessions_chat_turn_failed()}`,
      ]);
      expect(ticks().map((tick) => tick.getAttribute("data-state"))).toEqual([
        "done",
        "done",
        "stopped",
        "failed",
      ]);

      const list = rail()!.querySelector<HTMLElement>("[data-turn-list]")!;
      expect(list.dataset.turnList).toBe("closed");
      // One tab stop: the active row; focusing it opens the list.
      expect(rows().filter((row) => row.tabIndex === 0)).toEqual([
        activeRow()!,
      ]);
      await act(async () => activeRow()!.focus());
      expect(list.dataset.turnList).toBe("open");
      await act(async () => {
        activeRow()!.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "ArrowUp",
            bubbles: true,
          }),
        );
      });
      expect(document.activeElement === rows()[2]).toBe(true);
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
    moves.length = 0;
    top = 0;
  }

  async function frames() {
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function settle() {
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
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
