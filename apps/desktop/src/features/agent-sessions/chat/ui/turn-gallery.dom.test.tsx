import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentActivityItemDto,
  AgentMediaSegmentDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_TURN_GALLERY_DOM !== "1") {
  test("turn gallery DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TURN_GALLERY_DOM: "1" },
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

  const key: AgentSessionKeyDto = {
    agent: "codex",
    namespace: "acp",
    sessionId: "s1",
  };
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    if (command === "media_create_local_source") {
      const path = payload.path as string;
      return {
        format: "png",
        family: "image",
        mimeType: "image/png",
        sizeBytes: 100,
        generation: "g",
        width: null,
        height: null,
        animated: false,
        intrinsicOversized: false,
        inlinePreview: true,
        requiresRangeRequests: false,
        capabilityToken: `token:${path}`,
      };
    }
    if (command === "media_revoke_source") return null;
    if (command === "agent_runtime_media") {
      return { outcome: "available", mimeType: "image/png", data: "iVBORw==" };
    }
    if (command === "path_exists") return true;
    if (command === "home_dir" || command === "plugin:path|resolve_directory") {
      return "/Users/me";
    }
    throw new Error(`unexpected command ${command}`);
  });
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, protocol: string) => string;
      };
    }
  ).__TAURI_INTERNALS__.convertFileSrc = (path, protocol) =>
    `${protocol}://localhost/${path}`;

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { ChatTimeline } = await import("./chat-timeline");

  function segment(
    id: string,
    overrides: Partial<AgentMediaSegmentDto> = {},
  ): AgentMediaSegmentDto {
    return {
      id,
      kind: "image",
      name: null,
      mimeType: "image/png",
      path: `/project/${id}.png`,
      size: 2048,
      hasData: false,
      offset: null,
      ...overrides,
    };
  }

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
      ...(kind.kind === "tool_call" || kind.kind === "agent_message"
        ? { media: [] }
        : {}),
      ...kind,
    } as AgentActivityItemDto;
  }

  const tool = (
    id: string,
    turnId: string,
    toolKind: string,
    media: AgentMediaSegmentDto[] = [],
    extra: Record<string, unknown> = {},
  ) =>
    item(
      id,
      turnId,
      {
        kind: "tool_call",
        tool: toolKind,
        media,
        locations: [],
        mcpCalls: [],
        ...extra,
      },
      `Row ${id}`,
    );

  const user = (turnId: string, text: string) =>
    item(
      `user:${turnId}`,
      turnId,
      { kind: "user_message", segments: [] },
      text,
    );

  const answer = (
    id: string,
    turnId: string,
    text: string,
    media: AgentMediaSegmentDto[] = [],
  ) => item(id, turnId, { kind: "agent_message", media }, text);

  const done = (turnId: string) =>
    item(`outcome:${turnId}`, turnId, {
      kind: "turn_outcome",
      reason: "end_turn",
      durationMs: 3000,
    });

  const edit = (id: string, turnId: string, path: string) =>
    tool(id, turnId, "edit", [], {
      locations: [
        { path, change: "modified", lines: { added: 2, removed: 1 } },
      ],
    });

  /**
   * t1 makes images, views one, edits a file and a page through Svode MCP;
   * t3 and t4 answer with media of their own; t5 has no answer; t2 runs.
   */
  function snapshot(
    extra: AgentActivityItemDto[] = [],
  ): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        turnId: "t2",
        phase: "running",
        lastOutcome: null,
        status: {
          state: "running",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items: [
        user("t1", "Draw a bunny, then an apple and a pear"),
        answer("intro", "t1", "Drawing them now"),
        tool("bunny", "t1", "other", [segment("bunny")]),
        tool("fruit", "t1", "other", [segment("apple"), segment("pear")]),
        tool("view", "t1", "read", [segment("viewed")]),
        edit("edit", "t1", "/project/notes.md"),
        tool("page", "t1", "execute", [], {
          locations: [{ path: "/project/page.md", change: null, lines: null }],
          mcpCalls: [
            { server: "svode", tool: "write_page", changesProject: true },
          ],
        }),
        answer("done1", "t1", "Done: three pictures"),
        done("t1"),

        user("t3", "Show them"),
        tool("gen3", "t3", "other", [
          segment("own"),
          segment("written"),
          segment("marked"),
          segment("shot", { path: null, hasData: true }),
          segment("earlier"),
        ]),
        answer("mid3", "t3", "Earlier: ![earlier](/project/earlier.png)"),
        answer(
          "done3",
          "t3",
          "Here ![written](/project/written.png)\nMEDIA:/project/marked.png\n",
          [segment("own", { offset: 0 })],
        ),
        done("t3"),

        user("t4", "Again"),
        tool("gen4", "t4", "other", [segment("again")]),
        answer("done4", "t4", "![again](/project/again.png)"),
        done("t4"),

        user("t5", "Quietly"),
        tool("gen5", "t5", "other", [segment("quiet")]),
        edit("edit5", "t5", "/project/quiet.md"),
        done("t5"),

        ...extra,

        user("t2", "More"),
        tool("live", "t2", "other", [segment("live")], {
          status: "in_progress",
        }),
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
  async function mount(extra: AgentActivityItemDto[] = []) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <ChatTimeline session={key} snapshot={snapshot(extra)} />
          </TooltipProvider>
        </ThemeProvider>,
      );
    });
    await settle();
  }

  const items = () =>
    Array.from(
      document.querySelectorAll("[data-slot='message-scroller-item']"),
    );
  const rowOf = (id: string) =>
    Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(`Row ${id}`),
    );
  const itemWith = (text: string) =>
    items().find((element) => element.textContent?.includes(text));
  const galleryLabel = m.sessions_chat_turn_gallery();
  const isGallery = (element: Element | undefined) =>
    Boolean(
      element?.querySelector(`[role=group][aria-label="${galleryLabel}"]`),
    );
  /** Names of the tiles of the gallery in a scroller item, in order. */
  const tiles = (element: Element | undefined) =>
    Array.from(
      element?.querySelectorAll("[data-chat-media] [aria-label$='.png']") ?? [],
    )
      .map((tile) => tile.getAttribute("aria-label"))
      .join(",");
  /** The scroller items of a turn from its user's message on. */
  const turnItems = (userText: string, nextUserText: string | null) => {
    const all = items();
    const from = all.indexOf(itemWith(userText)!);
    const to = nextUserText ? all.indexOf(itemWith(nextUserText)!) : all.length;
    return all.slice(from, to);
  };
  const summaryOf = (count: number) =>
    Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(m.sessions_chat_turn_items({ count })),
    );

  test("a finished turn shows its created media under the answer, folded and open alike", async () => {
    try {
      await mount();
      const turn = () =>
        turnItems("Draw a bunny", "Show them").map((element) =>
          isGallery(element)
            ? `gallery:${tiles(element)}`
            : (element.textContent ?? "").includes(
                  m.sessions_chat_changed_files({ count: 2 }),
                )
              ? "files"
              : (element.textContent ?? "").slice(0, 16),
        );
      // Folded: the rows of created media count and fold with the rest.
      expect(rowOf("bunny")).toBe(undefined);
      expect(Boolean(summaryOf(6))).toBe(true);
      const folded = turn();
      expect(folded.slice(2)).toEqual([
        "Done: three pict",
        "gallery:bunny.png,apple.png,pear.png",
        "files",
      ]);
      const gallery = turnItems("Draw a bunny", "Show them").find(isGallery);

      // Open: each row of created media stands alone with its tiles at its
      // place, outside the group of actions; the tail stays the same.
      await click(summaryOf(6));
      await settle();
      const open = turn();
      expect(open.slice(-3)).toEqual(folded.slice(-3));
      expect(open.length > folded.length).toBe(true);
      expect(turnItems("Draw a bunny", "Show them").find(isGallery)).toBe(
        gallery,
      );
      for (const [id, names] of [
        ["bunny", "bunny.png"],
        ["fruit", "apple.png,pear.png"],
      ]) {
        const row = itemWith(`Row ${id}`);
        expect(
          row?.textContent?.includes(m.sessions_chat_tools({ count: 3 })),
        ).toBe(false);
        expect(tiles(row)).toBe(names);
      }
      // What the agent only viewed stays out of the gallery.
      expect(tiles(gallery).includes("viewed.png")).toBe(false);
    } finally {
      await unmountAll();
    }
  });

  test("the gallery leaves out what the answer shows, keeps media without a path and of earlier messages", async () => {
    try {
      await mount();
      const t3 = turnItems("Show them", "Again");
      const gallery = t3.find(isGallery);
      expect(Boolean(gallery)).toBe(true);
      expect(tiles(gallery)).toBe("earlier.png");
      // The data without a file is a tile too, named by its kind.
      expect(gallery?.querySelectorAll("[data-chat-media] button").length).toBe(
        2,
      );
      expect(t3.indexOf(gallery!)).toBe(t3.length - 1);

      // Everything the turn made is in its answer: no gallery.
      expect(turnItems("Again", "Quietly").some(isGallery)).toBe(false);
    } finally {
      await unmountAll();
    }
  });

  test("a turn without an answer ends with its gallery, then the changed files", async () => {
    try {
      await mount();
      const t5 = turnItems("Quietly", "More");
      const gallery = t5.findIndex(isGallery);
      expect(tiles(t5[gallery])).toBe("quiet.png");
      expect(gallery).toBe(t5.length - 2);
      expect(
        (t5.at(-1)?.textContent ?? "").includes(
          m.sessions_chat_changed_files({ count: 1 }),
        ),
      ).toBe(true);
    } finally {
      await unmountAll();
    }
  });

  test("what follows the answer stands before the gallery, which ends the turn folded and open", async () => {
    try {
      await mount([
        user("t6", "Draw and check"),
        tool("gen6", "t6", "other", [segment("sun")]),
        answer("done6", "t6", "Done: the sun"),
        tool("after6", "t6", "execute"),
        edit("edit6", "t6", "/project/sun.md"),
        done("t6"),
      ]);
      const turn = () =>
        turnItems("Draw and check", "More").map((element) =>
          isGallery(element)
            ? `gallery:${tiles(element)}`
            : (element.textContent ?? "").includes(
                  m.sessions_chat_changed_files({ count: 1 }),
                )
              ? "files"
              : (element.textContent ?? "").slice(0, 13),
        );
      const folded = turn();
      expect(folded.slice(-3)).toEqual([
        "Done: the sun",
        "gallery:sun.png",
        "files",
      ]);

      await click(summaryOf(3));
      await settle();
      const open = turn();
      const answerAt = open.indexOf("Done: the sun");
      const after = turnItems("Draw and check", "More").findIndex((element) =>
        element.textContent?.includes(m.sessions_chat_tools({ count: 2 })),
      );
      expect(answerAt < after).toBe(true);
      expect(open.slice(-2)).toEqual(["gallery:sun.png", "files"]);
      expect(after < open.length - 2).toBe(true);
    } finally {
      await unmountAll();
    }
  });

  test("a failed turn keeps its error and marker before the gallery", async () => {
    try {
      await mount([
        user("t7", "Draw then fail"),
        tool("gen7", "t7", "other", [segment("moon")]),
        answer("done7", "t7", "Drew the moon"),
        item("error7", "t7", { kind: "error" }, "connection reset by peer"),
        item("outcome:t7", "t7", {
          kind: "turn_outcome",
          reason: "error",
          durationMs: 3000,
        }),
      ]);
      const t7 = turnItems("Draw then fail", "More");
      const gallery = t7.findIndex(isGallery);
      expect(tiles(t7[gallery])).toBe("moon.png");
      expect(gallery).toBe(t7.length - 1);
      const answerAt = t7.findIndex((element) =>
        element.textContent?.includes("Drew the moon"),
      );
      const errorAt = t7.findIndex((element) =>
        element.textContent?.includes("connection reset by peer"),
      );
      expect(answerAt < errorAt && errorAt < gallery).toBe(true);
    } finally {
      await unmountAll();
    }
  });

  test("a running turn has no gallery and its row shows the tiles at the live edge", async () => {
    try {
      await mount();
      const t2 = turnItems("More", null);
      expect(t2.some(isGallery)).toBe(false);
      expect(tiles(itemWith("Row live"))).toBe("live.png");
    } finally {
      await unmountAll();
    }
  });

  async function unmountAll() {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
  }

  async function click(element: Element | undefined) {
    if (!element) throw new Error("nothing to click");
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
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
