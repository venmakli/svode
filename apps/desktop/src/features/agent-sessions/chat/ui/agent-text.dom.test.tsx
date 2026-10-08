import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

if (process.env.SVODE_AGENT_TEXT_DOM !== "1") {
  test("agent text DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_TEXT_DOM: "1" },
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
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { AttachmentOpenerContext } =
    await import("../hooks/use-attachment-opener");
  const { SessionCwdContext } = await import("../hooks/use-path-base");
  const { AgentText } = await import("./agent-text");
  const m = await import("@/paraglide/messages.js");

  const files = new Set([
    "/work/project/notes.md",
    "/work/project/src/main.rs",
    "/Users/me/todo.txt",
  ]);
  const folders = new Set(["/work/project/docs", "/Users/me/Downloads"]);
  const checked: string[] = [];
  const shellOpened: string[] = [];
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches += 1;
    return Promise.reject(new Error("Agent text must not fetch"));
  }) as typeof fetch;
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as { path?: string };
    if (command === "path_kind") {
      checked.push(payload.path!);
      if (files.has(payload.path!)) return "file";
      if (folders.has(payload.path!)) return "directory";
      return null;
    }
    if (command === "plugin:path|resolve_directory") return "/Users/me";
    if (command === "plugin:shell|open") {
      shellOpened.push(payload.path!);
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  const doc = dom.window.document;
  const opened: string[] = [];

  async function render(text: string) {
    const root = createRoot(doc.getElementById("app")!);
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <AttachmentOpenerContext.Provider
            value={(attachment) => opened.push(attachment.path)}
          >
            <SessionCwdContext.Provider value="/work/project">
              <AgentText text={text} />
            </SessionCwdContext.Provider>
          </AttachmentOpenerContext.Provider>
        </TooltipProvider>,
      );
    });
    await settle();
    return root;
  }

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  function linkTo(target: string): HTMLElement | null {
    return doc.querySelector<HTMLElement>(
      `[data-markdown-reader-link="${target}"]`,
    );
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
  }

  async function hover(element: HTMLElement): Promise<string> {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("pointermove", { bubbles: true }),
      );
    });
    await settle();
    // Radix repeats the content for screen readers in the tooltip role.
    return doc.querySelector('[role="tooltip"]')?.textContent ?? "";
  }

  test("links to existing local objects open them by the badge rule, folders in the file manager", async () => {
    const root = await render(
      [
        "[notes](notes.md) [main](src/main.rs:42) [lines](./src/main.rs#L10-L20)",
        "[uri](file:///work/project/notes.md) [home](~/todo.txt)",
        "[docs](docs/) [downloads](~/Downloads)",
      ].join("\n"),
    );
    try {
      const notes = linkTo("/work/project/notes.md")!;
      expect(notes.getAttribute("role")).toBe("link");
      expect(
        doc.querySelectorAll(
          '[data-markdown-reader-link="/work/project/src/main.rs"]',
        ).length,
      ).toBe(2);
      expect(Boolean(linkTo("/Users/me/todo.txt"))).toBe(true);
      expect(doc.querySelector("a[href]")).toBeNull();

      await click(notes);
      await click(linkTo("/work/project/src/main.rs")!);
      await click(linkTo("/Users/me/todo.txt")!);
      expect(opened).toEqual([
        "/work/project/notes.md",
        "/work/project/src/main.rs",
        "/Users/me/todo.txt",
      ]);

      await click(linkTo("/work/project/docs")!);
      await click(linkTo("/Users/me/Downloads")!);
      expect(shellOpened).toEqual([
        "/work/project/docs",
        "/Users/me/Downloads",
      ]);
      expect(opened.length).toBe(3);

      expect(await hover(linkTo("/work/project/src/main.rs")!)).toBe(
        "/work/project/src/main.rs:42",
      );
    } finally {
      await act(async () => root.unmount());
      opened.length = 0;
      shellOpened.length = 0;
    }
  });

  test("a link to a missing file is its text with the reason and the full path", async () => {
    const root = await render("See [the plan](plans/gone.md:3).");
    try {
      const missing = doc.querySelector<HTMLElement>(
        "[data-agent-text-missing-link]",
      )!;
      expect(missing.getAttribute("data-agent-text-missing-link")).toBe(
        "/work/project/plans/gone.md",
      );
      expect(missing.tagName).toBe("SPAN");
      expect(missing.textContent).toBe("the plan");
      expect(doc.querySelector("[data-markdown-reader-link]")).toBeNull();
      await click(missing);
      expect(opened).toEqual([]);
      expect(shellOpened).toEqual([]);
      const hint = await hover(missing);
      expect(hint.includes(m.sessions_chat_link_missing())).toBe(true);
      expect(hint.includes("/work/project/plans/gone.md:3")).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("http(s) opens in the browser with the full address; other schemes stay text", async () => {
    const root = await render(
      [
        "[site](https://example.com/a?b=1)",
        "[mail](mailto:me@example.com) [js](javascript:alert(1)) [ide](vscode://file/x) [anchor](#top)",
      ].join("\n"),
    );
    try {
      const site = linkTo("https://example.com/a?b=1")!;
      expect(await hover(site)).toBe("https://example.com/a?b=1");
      await click(site);
      expect(shellOpened).toEqual(["https://example.com/a?b=1"]);
      expect(doc.querySelectorAll("[data-markdown-reader-link]").length).toBe(
        1,
      );
      expect(
        doc.querySelectorAll("[data-markdown-reader-blocked-link]").length,
      ).toBe(4);
      expect(doc.body.innerHTML.includes("javascript:")).toBe(false);
      expect(dom.window.location.href).toBe("http://localhost/");
      expect(fetches).toBe(0);
    } finally {
      await act(async () => root.unmount());
      shellOpened.length = 0;
    }
  });

  test("a path in inline code opens only when it names an existing object, and looks like code", async () => {
    checked.length = 0;
    const root = await render(
      "Edit `/work/project/notes.md`, then `~/Downloads`; not `/work/project/gone.md`, `src/main.rs` or `npm test`.",
    );
    try {
      const codePaths = Array.from(
        doc.querySelectorAll<HTMLElement>("[data-agent-text-code-path]"),
      ).map((element) => element.getAttribute("data-agent-text-code-path"));
      expect(codePaths).toEqual([
        "/work/project/notes.md",
        "/Users/me/Downloads",
      ]);
      // Only absolute and `~` paths are checked.
      expect(checked.sort()).toEqual([
        "/Users/me/Downloads",
        "/work/project/gone.md",
        "/work/project/notes.md",
      ]);
      const codes = Array.from(
        doc.querySelectorAll<HTMLElement>('[data-streamdown="inline-code"]'),
      );
      expect(codes.length).toBe(5);
      expect(
        codes.every(
          (code) =>
            code.className ===
            "rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
        ),
      ).toBe(true);

      const notes = doc.querySelector<HTMLElement>(
        '[data-agent-text-code-path="/work/project/notes.md"]',
      )!;
      expect(notes.getAttribute("role")).toBe("link");
      await click(notes);
      expect(opened).toEqual(["/work/project/notes.md"]);
      await click(
        doc.querySelector<HTMLElement>(
          '[data-agent-text-code-path="/Users/me/Downloads"]',
        )!,
      );
      expect(shellOpened).toEqual(["/Users/me/Downloads"]);
    } finally {
      await act(async () => root.unmount());
      opened.length = 0;
      shellOpened.length = 0;
    }
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}
