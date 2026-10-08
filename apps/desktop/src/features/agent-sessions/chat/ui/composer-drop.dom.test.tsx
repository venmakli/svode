import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AgentSessionKeyDto } from "@/platform/agent-runtime/agent-runtime-api";
import { JSDOM } from "jsdom";

if (process.env.SVODE_COMPOSER_DROP_DOM !== "1") {
  test("composer drop DOM", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SVODE_COMPOSER_DROP_DOM: "1" },
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");

  const spaceState = {
    activeRootIcon: null,
    activeRootId: "root",
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
  /** Refusal lines the chat showed, as a paste shows them. */
  const toasts: string[] = [];
  const toast = Object.assign((message: string) => toasts.push(message), {
    error: (message: string) => toasts.push(message),
    success: () => undefined,
    info: () => undefined,
    warning: () => undefined,
    message: () => undefined,
    dismiss: () => undefined,
  });
  mock.module("sonner", () => ({ toast, Toaster: () => null }));

  const key: AgentSessionKeyDto = { agent: "codex", namespace: "native", sessionId: "s1" };
  /** What `path_kind` answers per absolute path; anything else is missing. */
  let kinds: Record<string, "file" | "directory"> = {};
  /** Paths that are there but cannot be read. */
  let unreadable: string[] = [];
  /** The paths of the system drag session. */
  let dragPaths: string[] = [];
  let snapshotFor: () => unknown = () => snapshot();
  const asked: string[] = [];

  const { mockNativeIpc, mockNativeWindow } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case "agent_runtime_subscribe": {
        const channel = payload.channel as { id: number };
        setTimeout(() =>
          runCallback(channel.id, {
            index: 0,
            message: { type: "snapshot", value: snapshotFor() },
          }),
        );
        return 1;
      }
      case "path_kind":
        asked.push(payload.path as string);
        return kinds[payload.path as string]
          ? {
              kind: kinds[payload.path as string],
              readable: !unreadable.includes(payload.path as string),
            }
          : null;
      case "path_exists":
        return true;
      case "native_file_drop_paths":
        return dragPaths;
      case "agent_runtime_hold_draft":
        return {
          hold: 5,
          check: { state: "ready", agent: { name: "codex-acp", version: "2.1.1" } },
          session: { ...key, sessionId: "d1" },
        };
      case "agent_setup_chat_agents":
        return {
          agents: [{ agent: "codex", name: "Codex", offer: { state: "available" } }],
          last: null,
        };
      case "agent_adapters_list_identities":
        return [{ id: "codex", displayName: "Codex" }];
      case "agent_runtime_unsubscribe":
      case "agent_runtime_release_draft":
        return null;
    }
    if (command.startsWith("plugin:")) return 1;
    throw new Error(`unexpected command ${command}`);
  }, { shouldMockEvents: true });
  mockNativeWindow();
  const { emit } = await import("@/platform/native/events");

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { SessionChat } = await import("./session-chat");
  const { NewSessionDraft } = await import("./new-session-draft");
  const { newSessionDraftKey, readComposerDraft, sessionDraftKey, writeComposerDraft } =
    await import("../model/composer");
  const { SVODE_RESOURCE_MIME } = await import("@/features/space/resource-drag");

  const DRAFT = sessionDraftKey("codex:s1");
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  function dropTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      kinds = {};
      unreadable = [];
      dragPaths = [];
      asked.length = 0;
      toasts.length = 0;
      snapshotFor = () => snapshot();
      try {
        await fn();
      } finally {
        await act(async () => root?.unmount());
        root = null;
        document.body.innerHTML = "";
        window.sessionStorage.clear();
        pointAt(null);
      }
    });
  }

  async function mount(element: React.ReactNode) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TooltipProvider>{element}</TooltipProvider>);
    });
    await settle();
  }

  const chat = () => (
    <SessionChat sessionId="codex:s1" session={key} scopeLabel="Project" />
  );

  function field() {
    return document.querySelector<HTMLElement>(
      `[aria-label="${m.sessions_chat_composer_label()}"]`,
    )!;
  }

  /** The surface the chat takes drops on: timeline and field. */
  function surface() {
    return container!.firstElementChild as HTMLElement;
  }

  /** What the stored draft holds: texts and badges by name, in order. */
  function draft(storageKey = DRAFT) {
    return (readComposerDraft(storageKey)?.parts ?? []).map((part) =>
      part.type === "text" ? part.text : `[${part.attachment.name}|${part.attachment.path}]`,
    );
  }

  function resource(value: Record<string, unknown>) {
    return transfer({
      [SVODE_RESOURCE_MIME]: JSON.stringify({
        version: 1,
        projectPath: "/project",
        spacePath: "/project",
        ...value,
      }),
    });
  }

  function transfer(data: Record<string, string>, files: boolean | File[] = false) {
    return {
      types: files ? ["Files"] : Object.keys(data),
      items: [],
      files: Array.isArray(files) ? files : [],
      dropEffect: "none",
      getData: (type: string) => data[type] ?? "",
    };
  }

  async function dispatchDrag(
    type: "dragenter" | "dragover" | "dragleave" | "drop",
    target: Element,
    dataTransfer: ReturnType<typeof transfer>,
    point = { x: 0, y: 0 },
  ) {
    await act(async () => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      target.dispatchEvent(event);
    });
    await settle();
  }

  async function drop(
    dataTransfer: ReturnType<typeof transfer>,
    point = { x: 0, y: 0 },
    target: Element = surface(),
  ) {
    await dispatchDrag("dragenter", target, dataTransfer, point);
    await dispatchDrag("drop", target, dataTransfer, point);
  }

  /**
   * What lies under a drop point: the text of the field at an offset, or
   * nothing in the field.
   */
  function pointAt(at: { text: Text; offset: number } | null) {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    doc.elementFromPoint = () => (at ? at.text.parentElement : document.body);
    doc.caretRangeFromPoint = () => {
      if (!at) return null;
      const range = document.createRange();
      range.setStart(at.text, at.offset);
      range.collapse(true);
      return range;
    };
  }

  function textNode(text: string): Text {
    const walker = document.createTreeWalker(field(), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent === text) return node as Text;
    }
    throw new Error(`no text ${text}`);
  }

  dropTest("a page, a file and a folder from the sidebar become badges in their order", async () => {
    kinds = {
      "/project/notes/plan.md": "file",
      "/project/assets/logo.png": "file",
      "/project/notes/roadmap": "directory",
      "/project/notes/roadmap/README.md": "file",
      "/project/tasks": "directory",
      "/project/archive": "directory",
    };
    await mount(chat());
    await drop(resource({ kind: "file", relativePath: "notes/plan.md", title: "Plan" }));
    await drop(resource({ kind: "file", relativePath: "assets/logo.png", title: "Logo" }));
    await drop(resource({ kind: "file", relativePath: "notes/roadmap", title: "Roadmap" }));
    await drop(resource({ kind: "collection", relativePath: "tasks", title: "Tasks" }));
    await drop(resource({ kind: "folder", relativePath: "archive", title: "archive" }));
    expect(draft()).toEqual([
      "[Plan|/project/notes/plan.md]",
      " ",
      "[logo.png|/project/assets/logo.png]",
      " ",
      "[Roadmap|/project/notes/roadmap/README.md]",
      " ",
      "[Tasks|/project/tasks/]",
      " ",
      "[archive|/project/archive/]",
      " ",
    ]);
    // A page by its title, a folder and a collection with the folder icon.
    expect(Boolean(document.querySelector('button[aria-label="Plan"] svg.lucide-file-text'))).toBe(true);
    expect(Boolean(document.querySelector('button[aria-label="Tasks"] svg.lucide-folder'))).toBe(true);
    expect(field().contains(document.activeElement)).toBe(true);
  });

  dropTest("a collection the tree names by its README becomes a folder badge of its directory", async () => {
    kinds = {
      "/project/tasks": "directory",
      "/project/tasks/README.md": "file",
    };
    await mount(chat());
    await drop(
      resource({ kind: "collection", relativePath: "tasks/README.md", title: "Tasks" }),
    );
    expect(draft()).toEqual(["[Tasks|/project/tasks/]", " "]);
    expect(Boolean(document.querySelector('button[aria-label="Tasks"] svg.lucide-folder'))).toBe(true);
  });

  dropTest("a leave between children without a related target keeps the highlight", async () => {
    await mount(chat());
    const target = surface();
    const bounds = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      return this === target
        ? new window.DOMRect(0, 0, 600, 400)
        : bounds.call(this);
    };
    const doc = document as Document & {
      elementFromPoint: (x: number, y: number) => Element | null;
    };
    const fromPoint = doc.elementFromPoint;
    doc.elementFromPoint = () => field();
    try {
      await dispatchDrag("dragenter", field(), resource({ kind: "file", relativePath: "notes/plan.md" }), { x: 100, y: 100 });
      // WebKit: moving onto another child fires a leave with no related target.
      await dispatchDrag("dragleave", field(), resource({ kind: "file", relativePath: "notes/plan.md" }), { x: 120, y: 100 });
      expect(target.textContent?.includes(m.sessions_chat_drop_attach())).toBe(true);
      // Leaving the window: the point lies outside the surface.
      await dispatchDrag("dragleave", target, resource({ kind: "file", relativePath: "notes/plan.md" }), { x: 900, y: 900 });
      expect(target.textContent?.includes(m.sessions_chat_drop_attach())).toBe(false);
    } finally {
      window.Element.prototype.getBoundingClientRect = bounds;
      doc.elementFromPoint = fromPoint;
    }
  });

  dropTest("files and folders of the OS become badges, a folder by its directory", async () => {
    dragPaths = ["/Users/me/shot.png", "/Users/me/drafts"];
    kinds = { "/Users/me/shot.png": "file", "/Users/me/drafts": "directory" };
    await mount(chat());
    await drop(transfer({}, true));
    expect(draft()).toEqual([
      "[shot.png|/Users/me/shot.png]",
      " ",
      "[drafts|/Users/me/drafts/]",
      " ",
    ]);
  });

  dropTest("Windows files and folders become badges, a folder by its directory", async () => {
    dragPaths = ["C:\\Users\\me\\Shot.PNG", "C:\\Users\\me\\drafts"];
    kinds = { "C:\\Users\\me\\Shot.PNG": "file", "C:\\Users\\me\\drafts": "directory" };
    await mount(chat());
    await drop(transfer({}, true));
    expect(draft()).toEqual([
      "[Shot.PNG|C:\\Users\\me\\Shot.PNG]",
      " ",
      "[drafts|C:\\Users\\me\\drafts\\]",
      " ",
    ]);
  });

  dropTest("files and folders from the Explorer become badges by the paths WebView2 hands", async () => {
    const files = [new File(["a"], "Shot.PNG"), new File([], "drafts")];
    const posted: unknown[][] = [];
    Object.assign(globalThis, {
      chrome: {
        webview: {
          postMessageWithAdditionalObjects(
            message: { svodeFileDrop: string },
            objects: ArrayLike<unknown>,
          ) {
            posted.push(Array.from(objects));
            void emit("webview-file-drop-paths", {
              id: message.svodeFileDrop,
              paths: ["C:\\Users\\me\\Shot.PNG", "C:\\Users\\me\\drafts"],
            });
          },
        },
      },
    });
    try {
      kinds = { "C:\\Users\\me\\Shot.PNG": "file", "C:\\Users\\me\\drafts": "directory" };
      await mount(chat());
      await drop(transfer({}, files));
      await settle();
      expect(posted).toEqual([files]);
      // No copy in the temp directory: an unexpected command would fail it.
      expect(draft()).toEqual([
        "[Shot.PNG|C:\\Users\\me\\Shot.PNG]",
        " ",
        "[drafts|C:\\Users\\me\\drafts\\]",
        " ",
      ]);
    } finally {
      Object.assign(globalThis, { chrome: undefined });
    }
  });

  dropTest("a file on a network share is refused without looking at it", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Keep me" }] });
    dragPaths = ["/Users/me/here.md", "\\\\server\\share\\a.md", "//server/share/b.md"];
    kinds = {
      "/Users/me/here.md": "file",
      "\\\\server\\share\\a.md": "file",
      "//server/share/b.md": "file",
    };
    await mount(chat());
    await drop(transfer({}, true));
    expect(draft()).toEqual(["Keep me"]);
    expect(toasts).toEqual([m.sessions_chat_drop_unavailable({ name: "a.md, b.md" })]);
    expect(asked).toEqual(["/Users/me/here.md"]);
  });

  dropTest("over the field a drop goes to its point, elsewhere to the caret, without focus to the end", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Hello world" }] });
    kinds = { "/a.md": "file", "/b.md": "file", "/c.md": "file" };
    await mount(chat());
    dragPaths = ["/a.md"];
    const text = textNode("Hello world");
    pointAt({ text, offset: 5 });
    // The field inserts the badge, not the path text the drag also carries.
    await drop(transfer({ "text/plain": "/a.md" }, true), { x: 0, y: 0 }, text.parentElement!);
    expect(draft()).toEqual(["Hello", "[a.md|/a.md]", "  world"]);
    // The field kept focus: a drop over the timeline goes to its caret.
    expect(field().contains(document.activeElement)).toBe(true);
    pointAt(null);
    dragPaths = ["/b.md"];
    await drop(transfer({}, true));
    expect(draft()).toEqual(["Hello", "[a.md|/a.md]", " ", "[b.md|/b.md]", "  world"]);
    await act(async () => (document.activeElement as HTMLElement).blur());
    dragPaths = ["/c.md"];
    await drop(transfer({}, true));
    expect(draft()).toEqual([
      "Hello",
      "[a.md|/a.md]",
      " ",
      "[b.md|/b.md]",
      "  world",
      "[c.md|/c.md]",
      " ",
    ]);
  });

  dropTest("an open request card refuses the drop with its reason and keeps the draft", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Keep me" }] });
    kinds = { "/project/notes/plan.md": "file" };
    snapshotFor = () => ({
      ...snapshot(),
      turn: { ...snapshot().turn, turnId: "t1", phase: "running" },
      pending: {
        id: "q1",
        kind: "question",
        title: "Which one?",
        toolCallId: null,
        options: [{ id: "a", label: "A", kind: "allow_once" }],
        fields: [],
        state: "pending",
      },
    });
    await mount(chat());
    const target = surface();
    const page = resource({ kind: "file", relativePath: "notes/plan.md" });
    await dispatchDrag("dragenter", target, page);
    expect(target.textContent?.includes(m.sessions_chat_drop_answer_first())).toBe(true);
    await dispatchDrag("dragover", target, page);
    expect(page.dropEffect).toBe("none");
    await dispatchDrag("drop", target, page);
    expect(draft()).toEqual(["Keep me"]);
    expect(asked).toEqual([]);
  });

  dropTest("a composer another process holds refuses with the composer's own reason", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Keep me" }] });
    snapshotFor = () => ({ ...snapshot(), writer: "none" });
    await mount(
      <SessionChat
        sessionId="codex:s1"
        session={key}
        scopeLabel="Project"
        continuation={{
          liveness: "external_active",
          attaching: false,
          refusal: null,
          attach: async () => false,
          refresh: () => undefined,
          refreshing: false,
          onCopyResumeCommand: null,
        }}
      />,
    );
    const target = surface();
    const page = resource({ kind: "file", relativePath: "notes/plan.md" });
    await dispatchDrag("dragenter", target, page);
    const overlay = target.querySelector('[aria-live="polite"]');
    expect(overlay?.textContent).toBe(m.sessions_chat_external_writer());
    await dispatchDrag("drop", target, page);
    expect(draft()).toEqual(["Keep me"]);
  });

  dropTest("an object that is not there is named in a refusal line and nothing is attached", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Keep me" }] });
    dragPaths = ["/Users/me/here.md", "/Users/me/gone.md"];
    kinds = { "/Users/me/here.md": "file" };
    await mount(chat());
    await dispatchDrag("dragenter", surface(), transfer({}, true));
    expect(surface().textContent?.includes(m.sessions_chat_drop_attach_count({ count: 2 }))).toBe(true);
    await dispatchDrag("drop", surface(), transfer({}, true));
    expect(draft()).toEqual(["Keep me"]);
    expect(toasts).toEqual([m.sessions_chat_drop_unavailable({ name: "gone.md" })]);
  });

  dropTest("an object that cannot be read is refused like a missing one", async () => {
    writeComposerDraft(DRAFT, { parts: [{ type: "text", text: "Keep me" }] });
    kinds = { "/project/private": "directory", "/Users/me/secret.md": "file" };
    unreadable = ["/project/private", "/Users/me/secret.md"];
    await mount(chat());
    await drop(resource({ kind: "folder", relativePath: "private", title: "private" }));
    dragPaths = ["/Users/me/secret.md"];
    await drop(transfer({}, true));
    expect(draft()).toEqual(["Keep me"]);
    expect(toasts).toEqual([
      m.sessions_chat_drop_unavailable({ name: "private" }),
      m.sessions_chat_drop_unavailable({ name: "secret.md" }),
    ]);
  });

  dropTest("the draft of a new session takes a drop the same way", async () => {
    kinds = { "/project/tasks": "directory" };
    await mount(
      <NewSessionDraft
        spacePath="/project"
        onStarted={() => undefined}
        onOpenTerminal={() => undefined}
        onOpenAgentSettings={() => undefined}
      />,
    );
    await drop(resource({ kind: "collection", relativePath: "tasks", title: "Tasks" }));
    expect(draft(newSessionDraftKey("/project"))).toEqual(["[Tasks|/project/tasks/]", " "]);
  });

  function snapshot() {
    return {
      seq: 0,
      session: key,
      connection: "ready",
      turn: {
        turnId: null,
        phase: "none",
        lastOutcome: null,
        status: { state: "idle", stopReason: null, source: "svode_runtime", confidence: "exact" },
      },
      items: [],
      pending: null,
      history: { source: "live", available: true, truncatedItems: null },
      writer: "acp",
      settings: [],
      commands: [],
      usage: null,
      title: null,
    };
  }

  function runCallback(id: number, data: unknown) {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
      }
    ).__TAURI_INTERNALS__.runCallback(id, data);
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
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
}
