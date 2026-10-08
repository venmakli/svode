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

if (process.env.SVODE_CHAT_MEDIA_DOM !== "1") {
  test("chat media DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CHAT_MEDIA_DOM: "1" },
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
  const sources: string[] = [];
  const revoked: string[] = [];
  const mediaReads: string[] = [];
  const systemOpened: string[] = [];
  const saved: string[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    if (command === "media_create_local_source") {
      const path = payload.path as string;
      sources.push(path);
      if (path === "/slow.png") return new Promise(() => {});
      if (path === "/gone.png") {
        throw { kind: "source_missing", message: "Media source is missing" };
      }
      if (path === "/photo.heic") {
        throw { kind: "unsupported_format", message: "Not supported" };
      }
      const video = path.endsWith(".mp4");
      return {
        format: video ? "mp4" : "png",
        family: video ? "video" : "image",
        mimeType: video ? "video/mp4" : "image/png",
        sizeBytes: 100,
        generation: "g",
        width: path === "/project/a.png" ? 400 : null,
        height: path === "/project/a.png" ? 200 : null,
        animated: false,
        intrinsicOversized: false,
        inlinePreview: !video,
        requiresRangeRequests: false,
        capabilityToken: `token:${path}`,
      };
    }
    if (command === "media_revoke_source") {
      revoked.push(payload.capabilityToken as string);
      return null;
    }
    if (command === "agent_runtime_media") {
      const segmentId = payload.segmentId as string;
      mediaReads.push(`${payload.itemId as string}/${segmentId}`);
      if (segmentId === "big") {
        return { outcome: "unavailable", reason: "too_large" };
      }
      if (segmentId === "old") {
        return { outcome: "unavailable", reason: "released" };
      }
      return { outcome: "available", mimeType: "audio/wav", data: "UklGRg==" };
    }
    if (command === "save_pasted_image") {
      // The data the runtime held, as the raw body of the write.
      saved.push(String((args as Uint8Array).length));
      return "/tmp/svode-pasted/voice.wav";
    }
    if (command === "plugin:shell|open") {
      systemOpened.push(payload.path as string);
      return null;
    }
    if (command === "path_exists") return payload.path !== "/gone.pdf";
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
  const { AttachmentOpenerContext } =
    await import("../hooks/use-attachment-opener");

  const opened: string[] = [];

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
  ) =>
    item(
      id,
      turnId,
      { kind: "tool_call", tool: toolKind, media, locations: [], mcpCalls: [] },
      `Row ${id}`,
    );

  const done = (turnId: string) =>
    item(`outcome:${turnId}`, turnId, {
      kind: "turn_outcome",
      reason: "end_turn",
      durationMs: 3000,
    });

  function snapshot(): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        turnId: "t2",
        phase: "none",
        lastOutcome: "end_turn",
        status: {
          state: "idle",
          stopReason: "end_turn",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items: [
        item("user:t1", "t1", { kind: "user_message", segments: [] }, "Draw"),
        tool("run", "t1", "execute"),
        tool("gen1", "t1", "other", [segment("a")]),
        tool("view", "t1", "read", [segment("seen")]),
        tool("gen2", "t1", "other", [
          segment("p1"),
          segment("p2"),
          segment("p3"),
          segment("p4"),
          segment("p5"),
        ]),
        item(
          "m1",
          "t1",
          {
            kind: "agent_message",
            media: [
              segment("voice", {
                kind: "audio",
                name: "voice",
                mimeType: "audio/wav",
                path: null,
                hasData: true,
                offset: 8,
              }),
              segment("report", {
                kind: "file",
                mimeType: "application/pdf",
                path: "/project/report.pdf",
                offset: 8,
              }),
              segment("lost", {
                kind: "file",
                mimeType: "application/pdf",
                path: "/gone.pdf",
                offset: 8,
              }),
            ],
          },
          "Before\n\nAfter",
        ),
        done("t1"),
        item("user:t2", "t2", { kind: "user_message", segments: [] }, "More"),
        tool("gen3", "t2", "other", [segment("x", { path: "/slow.png" })]),
        tool("gen4", "t2", "other", [segment("x", { path: "/gone.png" })]),
        tool("gen5", "t2", "other", [
          segment("big", { path: "/out/big.png", hasData: true }),
        ]),
        tool("gen6", "t2", "other", [
          segment("old", { path: null, hasData: true }),
        ]),
        tool("gen7", "t2", "other", [segment("x", { path: "/photo.heic" })]),
        tool("gen8", "t2", "other", [
          segment("x", {
            kind: "video",
            mimeType: "video/mp4",
            path: "/clip.mp4",
          }),
        ]),
        item("m2", "t2", { kind: "agent_message" }, "Done"),
        done("t2"),
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
  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        <ThemeProvider theme="light" setTheme={() => {}}>
          <TooltipProvider>
            <AttachmentOpenerContext.Provider
              value={(attachment) => opened.push(attachment.path)}
            >
              <ChatTimeline session={key} snapshot={snapshot()} />
            </AttachmentOpenerContext.Provider>
          </TooltipProvider>
        </ThemeProvider>,
      );
    });
    await settle();
  }

  const text = () => document.body.textContent ?? "";
  const rowOf = (id: string) =>
    Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(`Row ${id}`),
    );
  const buttonByLabel = (label: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === label,
    );
  const tileOf = (id: string) =>
    rowOf(id)?.parentElement?.querySelector("[data-chat-media]");

  test("a folded turn shows the rows of created media with their tiles and counts only what it folds", async () => {
    try {
      await mount();
      // Created media stay outside the fold, what the agent read folds.
      expect(Boolean(rowOf("gen1"))).toBe(true);
      expect(Boolean(rowOf("gen2"))).toBe(true);
      expect(rowOf("run")).toBe(undefined);
      expect(rowOf("view")).toBe(undefined);
      expect(text().includes(m.sessions_chat_turn_items({ count: 2 }))).toBe(
        true,
      );
      // The rows stand between the summary row and the last message.
      const summary = Array.from(document.querySelectorAll("button")).find(
        (button) =>
          button.textContent?.includes(
            m.sessions_chat_turn_items({ count: 2 }),
          ),
      )!;
      const answer = Array.from(document.querySelectorAll("p")).find(
        (element) => element.textContent === "Before",
      )!;
      expect(
        Boolean(
          summary.compareDocumentPosition(rowOf("gen1")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect(
        Boolean(
          rowOf("gen2")!.compareDocumentPosition(answer) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect(sources.includes("/project/seen.png")).toBe(false);

      // One image: uncropped, its place reserved by its known size.
      const single = buttonByLabel("a.png")!;
      expect(single.tagName).toBe("BUTTON");
      expect(
        (single.getAttribute("style") ?? "").includes(
          "aspect-ratio: 400 / 200",
        ),
      ).toBe(true);
      expect(single.querySelector("img")?.getAttribute("src")).toBe(
        "svode-media://localhost/token:/project/a.png",
      );
      await click(single);
      expect(opened).toEqual(["/project/a.png"]);

      // Five images: 2×2 whose last tile opens the rest.
      const layout = tileOf("gen2")!.querySelector("[data-media-layout]")!;
      expect(layout.getAttribute("data-media-layout")).toBe("grid");
      expect(layout.querySelectorAll("img").length).toBe(3);
      await click(
        buttonByLabel(m.sessions_chat_media_more_label({ count: 2 })),
      );
      await settle();
      const expanded = tileOf("gen2")!.querySelector("[data-media-layout]")!;
      expect(expanded.getAttribute("data-media-layout")).toBe("expanded");
      expect(expanded.querySelectorAll("img").length).toBe(5);
    } finally {
      await unmountAll();
    }
  });

  test("an agent message shows its media at their place: a player row and file cards", async () => {
    try {
      await mount();
      const before = Array.from(document.querySelectorAll("p")).find(
        (element) => element.textContent === "Before",
      )!;
      const audio = document.querySelector("audio")!;
      expect(audio.getAttribute("src")?.startsWith("blob:")).toBe(true);
      expect(
        Boolean(
          before.compareDocumentPosition(audio) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
      expect((mediaReads ?? "").includes("m1/voice")).toBe(true);

      const report = buttonByLabel("report.pdf")!;
      expect(
        (report.closest("[data-slot=attachment]")?.textContent ?? "").includes(
          "PDF · 2 KB",
        ),
      ).toBe(true);
      const lost = Array.from(
        document.querySelectorAll("[data-slot=attachment]"),
      ).find((card) => card.textContent?.includes("gone.pdf"))!;
      expect(lost.getAttribute("data-media-state")).toBe("missing");
      expect(
        (lost.textContent ?? "").includes(m.sessions_chat_media_unavailable()),
      ).toBe(true);
      expect(lost.querySelector("button")).toBe(null);

      // Media without a file opens through a temp file in its system app.
      const voice = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "voice",
      );
      await click(voice);
      await settle();
      expect(saved).toEqual(["4"]);
      expect(systemOpened).toEqual(["/tmp/svode-pasted/voice.wav"]);
    } finally {
      await unmountAll();
      systemOpened.length = 0;
    }
  });

  test("tiles show loading, a missing file, too large, released, an unreadable format and a video frame", async () => {
    try {
      await mount();
      const state = (id: string) =>
        tileOf(id)?.querySelector("[data-media-state]");

      const loading = state("gen3")!;
      expect(loading.getAttribute("data-media-state")).toBe("loading");
      expect((loading.className ?? "").includes("aspect-[4/3]")).toBe(true);

      const missing = state("gen4") as HTMLElement;
      expect(missing.getAttribute("data-media-state")).toBe("missing");
      expect(
        (missing.textContent ?? "").includes(
          m.sessions_chat_media_unavailable(),
        ),
      ).toBe(true);
      expect(missing.getAttribute("tabindex")).toBe("0");
      await act(async () => missing.focus());
      await settle();
      expect((text() ?? "").includes("/gone.png")).toBe(true);

      const large = state("gen5")!;
      expect(large.getAttribute("data-media-state")).toBe("too_large");
      expect(
        (large.textContent ?? "").includes(m.sessions_chat_media_too_large()),
      ).toBe(true);
      await click(
        Array.from(large.querySelectorAll("button")).find(
          (button) =>
            button.textContent === m.sessions_chat_media_open_in_app(),
        ),
      );
      expect(systemOpened).toEqual(["/out/big.png"]);

      const released = state("gen6")!;
      expect(released.getAttribute("data-media-state")).toBe("released");
      expect(
        (released.textContent ?? "").includes(m.sessions_chat_media_released()),
      ).toBe(true);
      expect(released.querySelector("button")).toBe(null);

      const unreadable = state("gen7")!;
      expect(unreadable.getAttribute("data-media-state")).toBe("error");
      expect((unreadable.textContent ?? "").includes("photo.heic")).toBe(true);
      expect(
        (unreadable.textContent ?? "").includes(
          m.sessions_chat_media_open_in_app(),
        ),
      ).toBe(true);

      const video = state("gen8")!;
      expect(video.getAttribute("data-media-state")).toBe("ready");
      expect(video.querySelector("video")?.getAttribute("preload")).toBe(
        "metadata",
      );
      expect(video.querySelector("video")?.getAttribute("src")).toBe(
        "svode-media://localhost/token:/clip.mp4",
      );
    } finally {
      await unmountAll();
    }
    // Unmounted tiles let their streams go.
    expect((revoked ?? "").includes("token:/clip.mp4")).toBe(true);
  });

  /** A turn that ends: running, then finished and folded. */
  function turnSnapshot(
    items: AgentActivityItemDto[],
    phase: "running" | "none",
  ): AgentSessionSnapshotDto {
    return {
      ...snapshot(),
      turn: {
        turnId: "t9",
        phase,
        lastOutcome: phase === "none" ? "end_turn" : null,
        status: {
          state: "running",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items,
    } as AgentSessionSnapshotDto;
  }

  /**
   * Renders as a runtime update does, outside `act`: React commits and runs
   * effects in separate tasks, and the scroller observes each commit.
   */
  async function update(root: Root, value: AgentSessionSnapshotDto) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    try {
      root.render(
        <TooltipProvider>
          <ChatTimeline session={key} snapshot={value} />
        </TooltipProvider>,
      );
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    }
  }

  /**
   * Folds a turn whose tool calls created media while the timeline follows
   * its end, and returns where the scroller moved the viewport.
   */
  async function foldMoves(live: AgentActivityItemDto[]): Promise<number[]> {
    const earlier = [
      item("u0", "t0", { kind: "user_message", segments: [] }, "Hello"),
      item("m0", "t0", { kind: "agent_message" }, "Hi"),
      done("t0"),
      item("u9", "t9", { kind: "user_message", segments: [] }, "Draw"),
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ChatTimeline
            session={key}
            snapshot={turnSnapshot(earlier, "running")}
          />
        </TooltipProvider>,
      );
    });
    await settle();
    const viewport = container.querySelector<HTMLElement>(
      "[data-slot='message-scroller-viewport']",
    )!;
    // A long timeline at its end: the end is far below the first message.
    let top = 4900;
    const moves: number[] = [];
    Object.defineProperty(viewport, "clientHeight", { value: 100 });
    Object.defineProperty(viewport, "scrollHeight", { value: 5000 });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        moves.push(value);
        top = value;
      },
    });
    viewport.scrollTo = ((options: { top: number }) => {
      moves.push(options.top);
      top = options.top;
    }) as never;
    const rect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      return this === viewport
        ? new window.DOMRect(0, 0, 600, 100)
        : new window.DOMRect(0, -4900, 600, 5000);
    };
    try {
      await update(root, turnSnapshot([...earlier, ...live], "running"));
      moves.length = 0;
      await update(
        root,
        turnSnapshot(
          [
            ...earlier,
            ...live.map((entry) => ({
              ...entry,
              status: "completed" as const,
            })),
            done("t9"),
          ],
          "none",
        ),
      );
      return moves;
    } finally {
      window.Element.prototype.getBoundingClientRect = rect;
    }
  }

  test("folding a turn with created media keeps the timeline at its end", async () => {
    try {
      const moves = await foldMoves([
        tool("g9", "t9", "other", [segment("g", { path: "/project/g.png" })]),
        tool("r9", "t9", "execute"),
        item("m9", "t9", { kind: "agent_message" }, "Drawn"),
      ]);
      // Every move follows the end; none goes to a message above it.
      expect(moves.every((value) => value === 4900)).toBe(true);
      expect(Boolean(rowOf("g9"))).toBe(true);
      expect(rowOf("r9")).toBe(undefined);
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
