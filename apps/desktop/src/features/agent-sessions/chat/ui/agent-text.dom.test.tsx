import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import { testFetch } from "@/shared/testing/fetch";

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
    "/work/project/reports/dashboard.html",
    "/work/project/reports/a-very-long-name-of-a-generated-report-page.html",
    "/work/project/img/chart.png",
    "/abs/a.html",
    "/work/project/src/main.rs",
    "/Users/me/todo.txt",
    "C:\\work\\project\\notes.md",
    "C:\\work\\project\\src\\main.rs",
  ]);
  const folders = new Set([
    "/work/project/docs",
    "/Users/me/Downloads",
    "C:\\Users\\me\\Downloads",
  ]);
  /** There but not readable: a link still opens it. */
  const unreadable = new Set(["/Users/me/todo.txt"]);
  const checked: string[] = [];
  const shellOpened: string[] = [];
  let fetches = 0;
  globalThis.fetch = testFetch(() => {
    fetches += 1;
    return Promise.reject(new Error("Agent text must not fetch"));
  });
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as { path?: string };
    if (command === "path_kind") {
      checked.push(payload.path!);
      const readable = !unreadable.has(payload.path!);
      if (files.has(payload.path!)) return { kind: "file", readable };
      if (folders.has(payload.path!)) return { kind: "directory", readable };
      return null;
    }
    if (command === "path_exists") {
      // A folder badge names its directory with the separator.
      const path = payload.path!.replace(/(?<=.)[\\/]+$/, "");
      return files.has(path) || folders.has(path);
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

  async function render(text: string, cwd = "/work/project") {
    const root = createRoot(doc.getElementById("app")!);
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <AttachmentOpenerContext.Provider
            value={(attachment) => opened.push(attachment.path)}
          >
            <SessionCwdContext.Provider value={cwd}>
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
    return withAttribute("data-markdown-reader-link", target);
  }

  /** Badges of objects, by their accessible names. */
  function badgeNames(): string[] {
    return Array.from(
      doc.querySelectorAll<HTMLElement>('[data-slot="hover-card-trigger"]'),
    ).map((badge) => badge.getAttribute("aria-label") ?? "");
  }

  function badge(name: string): HTMLElement {
    return withAttribute("aria-label", name)!;
  }

  function iconOf(element: HTMLElement): string {
    return (
      Array.from(element.querySelector("svg")?.classList ?? []).find(
        (name) => name.startsWith("lucide-"),
      ) ?? ""
    );
  }

  /** The hover card of a badge, opened by the pointer after its delay. */
  async function hoverCard(element: HTMLElement): Promise<string> {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("pointerover", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();
    return (
      doc.querySelector('[data-slot="hover-card-content"]')?.textContent ?? ""
    );
  }

  /** By the value as is: a Windows path holds what CSS reads as escapes. */
  function withAttribute(name: string, value: string): HTMLElement | null {
    return (
      Array.from(doc.querySelectorAll<HTMLElement>(`[${name}]`)).find(
        (element) => element.getAttribute(name) === value,
      ) ?? null
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
        "[the docs](docs/) [downloads](~/Downloads)",
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

  test("a path in inline code is a badge only when it names an existing object, else code", async () => {
    checked.length = 0;
    const root = await render(
      "Edit `/work/project/notes.md`, then `~/Downloads`; not `/work/project/gone.md`, `src/main.rs` or `npm test`.",
    );
    try {
      expect(badgeNames()).toEqual(["notes.md", "Downloads"]);
      // Only absolute and `~` paths are checked.
      expect(checked.sort()).toEqual([
        "/Users/me/Downloads",
        "/work/project/gone.md",
        "/work/project/notes.md",
      ]);
      const codes = Array.from(
        doc.querySelectorAll<HTMLElement>('[data-streamdown="inline-code"]'),
      );
      expect(codes.map((code) => code.textContent)).toEqual([
        "/work/project/gone.md",
        "src/main.rs",
        "npm test",
      ]);
      expect(
        codes.every(
          (code) =>
            code.className ===
            "rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
        ),
      ).toBe(true);

      await click(badge("notes.md"));
      expect(opened).toEqual(["/work/project/notes.md"]);
      await click(badge("Downloads"));
      expect(shellOpened).toEqual(["/Users/me/Downloads"]);
    } finally {
      await act(async () => root.unmount());
      opened.length = 0;
      shellOpened.length = 0;
    }
  });

  test("Windows paths open by the same rules in either separator", async () => {
    checked.length = 0;
    const root = await render(
      [
        "[notes](notes.md) [main](C:/work/project/src/main.rs:42)",
        "and `C:\\Users\\me\\Downloads` or `C:\\work\\project\\gone.md:3`",
      ].join("\n"),
      "C:\\work\\project",
    );
    try {
      await click(linkTo("C:\\work\\project\\notes.md")!);
      await click(linkTo("C:\\work\\project\\src\\main.rs")!);
      expect(opened).toEqual([
        "C:\\work\\project\\notes.md",
        "C:\\work\\project\\src\\main.rs",
      ]);
      expect(await hover(linkTo("C:\\work\\project\\src\\main.rs")!)).toBe(
        "C:\\work\\project\\src\\main.rs:42",
      );
      await click(badge("Downloads"));
      expect(shellOpened).toEqual(["C:\\Users\\me\\Downloads"]);
      expect(checked.sort()).toEqual([
        "C:\\Users\\me\\Downloads",
        "C:\\work\\project\\gone.md",
        "C:\\work\\project\\notes.md",
        "C:\\work\\project\\src\\main.rs",
      ]);
    } finally {
      await act(async () => root.unmount());
      opened.length = 0;
      shellOpened.length = 0;
    }
  });

  test("paths in inline code are badges of their objects, named without the path", async () => {
    const root = await render(
      [
        "Created `/work/project/reports/dashboard.html`, `/work/project/notes.md`,",
        "`/work/project/img/chart.png`, `/work/project/docs` and `/work/project/src/main.rs:42`.",
      ].join(" "),
    );
    try {
      expect(badgeNames()).toEqual([
        "dashboard.html",
        "notes.md",
        "chart.png",
        "docs",
        "main.rs:42",
      ]);
      expect(badge("dashboard.html").tagName).toBe("BUTTON");
      expect(iconOf(badge("dashboard.html"))).toBe("lucide-file");
      expect(iconOf(badge("notes.md"))).toBe("lucide-file-text");
      expect(iconOf(badge("chart.png"))).toBe("lucide-image");
      expect(iconOf(badge("docs"))).toBe("lucide-folder");
      const text = doc.getElementById("app")!.textContent ?? "";
      expect(text.includes("/work/project")).toBe(false);
      expect(doc.querySelector('[data-streamdown="inline-code"]')).toBeNull();

      await click(badge("dashboard.html"));
      await click(badge("main.rs:42"));
      expect(opened).toEqual([
        "/work/project/reports/dashboard.html",
        "/work/project/src/main.rs",
      ]);
      await click(badge("docs"));
      expect(shellOpened).toEqual(["/work/project/docs"]);
      expect(opened.length).toBe(2);

      const card = await hoverCard(badge("dashboard.html"));
      expect(card.includes("/work/project/reports/dashboard.html")).toBe(true);
      expect(card.includes(m.sessions_chat_attachment_file_type({ type: "HTML" }))).toBe(
        true,
      );
    } finally {
      await act(async () => root.unmount());
      opened.length = 0;
      shellOpened.length = 0;
    }
  });

  test("a link that only names its object is its badge; a link with a name of its own stays a link", async () => {
    const root = await render(
      [
        "[/abs/a.html](/abs/a.html) and [a.html](/abs/a.html), [`notes.md`](notes.md)",
        "[Отчёт](notes.md), [gone.md](gone.md)",
        "[a-very-long-name-of-a-generated-report-page.html is the report of this week](reports/a-very-long-name-of-a-generated-report-page.html)",
        "[https://example.com/a/very/long/address/that/does/not/fit/on/one/line](https://example.com/a/very/long/address/that/does/not/fit/on/one/line)",
      ].join("\n"),
    );
    try {
      expect(badgeNames()).toEqual(["a.html", "a.html", "notes.md"]);
      await click(badge("notes.md"));
      expect(opened).toEqual(["/work/project/notes.md"]);

      const report = linkTo("/work/project/notes.md")!;
      expect(report.textContent).toBe("Отчёт");
      // A missing target is its text with the reason, as before.
      expect(
        doc
          .querySelector("[data-agent-text-missing-link]")
          ?.getAttribute("data-agent-text-missing-link"),
      ).toBe("/work/project/gone.md");

      // Labelled links wrap as text: from the start of the line, a long
      // word anywhere.
      for (const link of [
        linkTo(
          "/work/project/reports/a-very-long-name-of-a-generated-report-page.html",
        )!,
        linkTo(
          "https://example.com/a/very/long/address/that/does/not/fit/on/one/line",
        )!,
      ]) {
        const classes = link.className.split(" ");
        expect(classes.includes("text-start")).toBe(true);
        expect(classes.includes("[overflow-wrap:anywhere]")).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
      opened.length = 0;
    }
  });

  test("a path on a network share is plain text that nothing looks at", async () => {
    checked.length = 0;
    const root = await render(
      [
        "[a](file:////server/share/a.md) [b](//server/share/b.md) [c](file://server/share/c.md)",
        "[d](file:///%5C%5Cserver/share/d.md) and `\\\\server\\share\\e.md`, `//server/share/f.md`",
      ].join("\n"),
      "C:\\work\\project",
    );
    try {
      expect(doc.querySelector("[data-markdown-reader-link]")).toBeNull();
      expect(doc.querySelector('[data-slot="hover-card-trigger"]')).toBeNull();
      expect(doc.querySelector("[data-agent-text-missing-link]")).toBeNull();
      expect(
        doc.querySelectorAll("[data-markdown-reader-blocked-link]").length,
      ).toBe(4);
      expect(checked).toEqual([]);
      for (const text of Array.from(
        doc.querySelectorAll<HTMLElement>("[data-markdown-reader-blocked-link]"),
      )) {
        await click(text);
      }
      expect(opened).toEqual([]);
      expect(shellOpened).toEqual([]);
    } finally {
      await act(async () => root.unmount());
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
    NodeFilter: dom.window.NodeFilter,
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
