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

if (process.env.SVODE_TURN_WEB_PREVIEWS_DOM !== "1") {
  test("turn web previews DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TURN_WEB_PREVIEWS_DOM: "1" },
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
  const appLookups: string[] = [];
  /** The Space is itself an App: every file of it belongs to that App. */
  let spaceIsApp = false;
  const gone = new Set(["/project/gone.html", "/project/old.html"]);
  /** While set, existence answers wait for it. */
  let existsGate: Promise<void> | null = null;
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
    if (command === "html_document_app_directory") {
      appLookups.push(payload.targetPath as string);
      if (spaceIsApp) return ".";
      return payload.targetPath === "tools/dash/index.html"
        ? "tools/dash"
        : null;
    }
    if (command === "path_exists") {
      const exists = !gone.has(payload.path as string);
      return existsGate ? existsGate.then(() => exists) : exists;
    }
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
  const { AttachmentOpenerContext } =
    await import("../hooks/use-attachment-opener");
  const { registerRootSpace } = await import("@/features/space");
  const { useGitStore } = await import("@/features/git");
  registerRootSpace({ id: "root", name: "Project", path: "/project" } as never);

  const opened: string[] = [];

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
    extra: Record<string, unknown> = {},
  ) =>
    item(
      id,
      turnId,
      {
        kind: "tool_call",
        tool: toolKind,
        media: [],
        locations: [],
        mcpCalls: [],
        ...extra,
      },
      `Row ${id}`,
    );

  const write = (id: string, turnId: string, path: string) =>
    tool(id, turnId, "edit", {
      locations: [{ path, change: "created", lines: { added: 3, removed: 0 } }],
    });

  const user = (turnId: string, text: string) =>
    item(
      `user:${turnId}`,
      turnId,
      { kind: "user_message", segments: [] },
      text,
    );

  const answer = (id: string, turnId: string, text: string) =>
    item(id, turnId, { kind: "agent_message" }, text);

  const done = (turnId: string) =>
    item(`outcome:${turnId}`, turnId, {
      kind: "turn_outcome",
      reason: "end_turn",
      durationMs: 3000,
    });

  const image: AgentMediaSegmentDto = {
    id: "chart",
    kind: "image",
    name: null,
    mimeType: "image/png",
    path: "/project/chart.png",
    size: 2048,
    hasData: false,
    offset: null,
  };

  /**
   * t1 draws a chart and writes six HTML files, one of them gone since and
   * one of an App; t2 changes only Markdown; t4 moves old.html to
   * new.html and writes three more; t3 runs and writes HTML.
   */
  function snapshot(): AgentSessionSnapshotDto {
    return {
      seq: 1,
      session: key,
      connection: "ready",
      turn: {
        turnId: "t3",
        phase: "running",
        lastOutcome: null,
        status: {
          state: "running",
          source: "svode_runtime",
          confidence: "exact",
        },
      },
      items: [
        user("t1", "Build the pages"),
        tool("draw", "t1", "other", { media: [image] }),
        write("w1", "t1", "/project/a.html"),
        write("w2", "t1", "/project/gone.html"),
        write("w3", "t1", "/project/tools/dash/index.html"),
        write("w4", "t1", "/project/b.html"),
        write("w5", "t1", "/project/.scratch/c.html"),
        write("w6", "t1", "/project/d.html"),
        write("w7", "t1", "/project/notes.md"),
        answer("done1", "t1", "Done: the pages"),
        done("t1"),

        user("t2", "Only notes"),
        write("w8", "t2", "/project/notes.md"),
        answer("done2", "t2", "Done: notes"),
        done("t2"),

        user("t4", "Move pages"),
        tool("mv", "t4", "move", {
          locations: [
            { path: "/project/old.html", change: "moved", lines: null },
            { path: "/project/new.html", change: "moved", lines: null },
          ],
        }),
        write("w10", "t4", "/project/n1.html"),
        write("w11", "t4", "/project/n2.html"),
        write("w12", "t4", "/project/n3.html"),
        answer("done4", "t4", "Done: moved"),
        done("t4"),

        user("t3", "More"),
        write("w9", "t3", "/project/live.html"),
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

  const items = () =>
    Array.from(
      document.querySelectorAll("[data-slot='message-scroller-item']"),
    );
  const itemWith = (text: string) =>
    items().find((element) => element.textContent?.includes(text));
  const turnItems = (userText: string, nextUserText: string | null) => {
    const all = items();
    const from = all.indexOf(itemWith(userText)!);
    const to = nextUserText ? all.indexOf(itemWith(nextUserText)!) : all.length;
    return all.slice(from, to);
  };
  const cards = (element: Element | undefined) =>
    Array.from(
      element?.querySelectorAll<HTMLButtonElement>("[data-web-preview]") ?? [],
    );
  /** A scroller item as a word: what it holds, for the order of a turn. */
  const describe = (element: Element) => {
    const names = cards(element).map((card) => card.textContent);
    if (names.length > 0) return `previews:${names.join(",")}`;
    if (
      element.querySelector(
        `[role=group][aria-label="${m.sessions_chat_turn_gallery()}"]`,
      )
    ) {
      return "gallery";
    }
    const text = element.textContent ?? "";
    if (text.includes(m.sessions_chat_changed_files({ count: 7 }))) {
      return "files";
    }
    return text.slice(0, 15);
  };
  const summaryOf = (count: number) =>
    Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(m.sessions_chat_turn_items({ count })),
    );
  const preview = m.sessions_chat_web_preview();

  test("a finished turn shows up to three Web preview rows between its media and its changed files, folded and open", async () => {
    try {
      await mount();
      const turn = () =>
        turnItems("Build the pages", "Only notes").map(describe);
      const folded = turn();
      // The hidden folder and the App file are left out, the fourth file
      // is only in the changed files.
      expect(folded.slice(-4)).toEqual([
        "Done: the pages",
        "gallery",
        `previews:a.html${preview},gone.html${preview},b.html${preview}`,
        "files",
      ]);

      await click(summaryOf(8));
      await settle();
      const open = turn();
      expect(open.length > folded.length).toBe(true);
      expect(open.slice(-3)).toEqual(folded.slice(-3));
    } finally {
      await unmountAll();
    }
  });

  test("a turn without HTML files and a running turn have no Web preview", async () => {
    try {
      await mount();
      expect(
        turnItems("Only notes", "Move pages").some(
          (element) => cards(element).length > 0,
        ),
      ).toBe(false);
      expect(
        turnItems("More", null).some((element) => cards(element).length > 0),
      ).toBe(false);
      // Only the files of the finished turn were asked about an App.
      expect(appLookups.includes("live.html")).toBe(false);
    } finally {
      await unmountAll();
    }
  });

  test("a card opens its file by the badge rule and shows its path; a gone file's card does nothing", async () => {
    try {
      await mount();
      opened.length = 0;
      const [first, gone] = cards(itemWith(preview));
      expect(first.getAttribute("aria-disabled")).toBe("false");
      expect(first.getAttribute("aria-label")).toBe(`a.html, ${preview}`);
      expect(gone.getAttribute("aria-disabled")).toBe("true");

      await act(async () => first.focus());
      await settle();
      expect(tooltipText()).toBe("/project/a.html");
      await act(async () => first.blur());
      await settle();

      await act(async () => gone.focus());
      await settle();
      expect(tooltipText()).toBe(m.sessions_chat_changed_file_removed());

      await click(gone);
      await click(first);
      expect(opened).toEqual(["/project/a.html"]);
    } finally {
      await unmountAll();
    }
  });

  test("a Space that is itself an App gives its HTML files no Web preview", async () => {
    spaceIsApp = true;
    try {
      await mount();
      expect(
        turnItems("Build the pages", "Only notes").map(describe).slice(-3),
      ).toEqual(["Done: the pages", "gallery", "files"]);
      expect(document.querySelector("[data-turn-web-previews]")).toBe(null);
    } finally {
      spaceIsApp = false;
      await unmountAll();
    }
  });

  test("a changed Git state of a card's file checks it again without hiding or moving the cards", async () => {
    let open = () => {};
    try {
      await mount();
      const names = () =>
        cards(itemWith(preview)).map((card) => card.textContent);
      const before = names();
      const lookups = appLookups.length;

      // An unrelated file changes: the cards are not checked again.
      await act(async () => {
        useGitStore.setState({
          statuses: {
            "/project": { files: [{ path: "notes.md", state: "modified" }] },
          } as never,
        });
      });
      await settle();
      expect(appLookups.length).toBe(lookups);

      // a.html is deleted: while the check runs the cards stay as they were.
      gone.add("/project/a.html");
      existsGate = new Promise((resolve) => {
        open = resolve;
      });
      await act(async () => {
        useGitStore.setState({
          statuses: {
            "/project": {
              files: [
                { path: "notes.md", state: "modified" },
                { path: "a.html", state: "deleted" },
              ],
            },
          } as never,
        });
      });
      await settle();
      expect(appLookups.length > lookups).toBe(true);
      expect(names()).toEqual(before);
      expect(cards(itemWith(preview))[0].getAttribute("aria-disabled")).toBe(
        "false",
      );

      open();
      existsGate = null;
      await settle();
      expect(names()).toEqual(before);
      expect(cards(itemWith(preview))[0].getAttribute("aria-disabled")).toBe(
        "true",
      );
    } finally {
      open();
      existsGate = null;
      gone.delete("/project/a.html");
      await act(async () => useGitStore.setState({ statuses: {} }));
      await unmountAll();
    }
  });

  test("a moved file that is gone gets no card and takes no place; one gone later leaves without moving the rest", async () => {
    try {
      await mount();
      const names = () =>
        turnItems("Move pages", "More").flatMap((element) =>
          cards(element).map((card) => card.textContent),
        );
      // `mv old.html new.html`: only new.html, and old.html leaves its
      // place to n2.html.
      expect(names()).toEqual([
        `new.html${preview}`,
        `n1.html${preview}`,
        `n2.html${preview}`,
      ]);

      // new.html is moved away after the turn: its row leaves, the others
      // keep their order and n3.html takes the free place.
      gone.add("/project/new.html");
      await act(async () => {
        useGitStore.setState({
          statuses: {
            "/project": { files: [{ path: "new.html", state: "deleted" }] },
          } as never,
        });
      });
      await settle();
      expect(names()).toEqual([
        `n1.html${preview}`,
        `n2.html${preview}`,
        `n3.html${preview}`,
      ]);
      expect(
        turnItems("Move pages", "More").flatMap((element) =>
          cards(element).map((card) => card.getAttribute("aria-disabled")),
        ),
      ).toEqual(["false", "false", "false"]);
    } finally {
      gone.delete("/project/new.html");
      await act(async () => useGitStore.setState({ statuses: {} }));
      await unmountAll();
    }
  });

  function tooltipText() {
    return document.querySelector("[role=tooltip]")?.textContent ?? null;
  }

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
