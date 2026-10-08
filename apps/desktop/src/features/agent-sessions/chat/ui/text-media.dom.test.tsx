import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_TEXT_MEDIA_DOM !== "1") {
  test("text media DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_TEXT_MEDIA_DOM: "1" },
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

  /** Every image the window asks to load: the only network requests here. */
  const loads: { src: string; referrerPolicy: string }[] = [];
  const failing = new Set<string>();
  class RecordingImage {
    referrerPolicy = "";
    naturalWidth = 640;
    naturalHeight = 480;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      loads.push({ src: value, referrerPolicy: this.referrerPolicy });
      setTimeout(() =>
        failing.has(value) ? this.onerror?.() : this.onload?.(),
      );
    }
  }
  Object.assign(globalThis, { Image: RecordingImage });
  Object.assign(dom.window, { Image: RecordingImage });
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches += 1;
    return Promise.reject(new Error("Agent text must not fetch"));
  }) as typeof fetch;

  const sources: string[] = [];
  const shellOpened: string[] = [];
  const saved: string[] = [];
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc((command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    if (command === "media_create_local_source") {
      const path = payload.path as string;
      sources.push(path);
      if (path === "/abs/huge.png") {
        throw { kind: "resource_limit", message: "Too large" };
      }
      const family = path.endsWith(".wav") ? "audio" : "image";
      return {
        format: family === "audio" ? "wav" : "png",
        family,
        mimeType: family === "audio" ? "audio/wav" : "image/png",
        sizeBytes: 100,
        generation: "g",
        width: 400,
        height: 200,
        animated: false,
        intrinsicOversized: false,
        inlinePreview: true,
        requiresRangeRequests: false,
        capabilityToken: `token:${path}`,
      };
    }
    if (command === "media_revoke_source") return null;
    if (command === "path_exists") return true;
    if (command === "plugin:path|resolve_directory") return "/Users/me";
    if (command === "save_pasted_image") {
      saved.push(String((args as Uint8Array).length));
      return "/tmp/svode-pasted/dot.png";
    }
    if (command === "plugin:shell|open") {
      shellOpened.push(payload.path as string);
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, protocol: string) => string;
      };
    }
  ).__TAURI_INTERNALS__.convertFileSrc = (path, protocol) =>
    `${protocol}://localhost/${path}`;

  const { createRoot } = await import("react-dom/client");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const m = await import("@/paraglide/messages.js");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { AttachmentOpenerContext } =
    await import("../hooks/use-attachment-opener");
  const { SessionCwdContext } = await import("../hooks/use-path-base");
  const { RevealedImagesProvider } =
    await import("../hooks/use-revealed-images");
  const { AgentText } = await import("./agent-text");

  const doc = dom.window.document;
  const opened: string[] = [];
  const mounted: Root[] = [];

  function tree(text: string, streaming = false): ReactNode {
    return (
      <TooltipProvider delayDuration={0}>
        <AttachmentOpenerContext.Provider
          value={(attachment) => opened.push(attachment.path)}
        >
          <SessionCwdContext.Provider value="/work/project">
            <AgentText text={text} streaming={streaming} />
          </SessionCwdContext.Provider>
        </AttachmentOpenerContext.Provider>
      </TooltipProvider>
    );
  }

  async function render(node: ReactNode): Promise<Root> {
    const container = doc.createElement("div");
    doc.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => root.render(node));
    await settle();
    return root;
  }

  async function unmountAll() {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
    doc.body.replaceChildren();
  }

  async function settle() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  async function click(element: Element | null | undefined) {
    if (!element) throw new Error("nothing to click");
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
  }

  async function hover(element: Element): Promise<string> {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("pointermove", { bubbles: true }),
      );
    });
    await settle();
    return doc.querySelector('[role="tooltip"]')?.textContent ?? "";
  }

  const byLabel = (label: string) =>
    doc.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  const buttonByText = (text: string) =>
    Array.from(doc.querySelectorAll("button")).find(
      (button) => button.textContent === text,
    );

  test("markdown images with a local path or data are tiles at their place, outside paragraphs", async () => {
    const dot = "data:image/png;base64,iVBORw0KGgo=";
    try {
      await render(
        tree(
          [
            "Here is ![Bunny](/abs/a.png)",
            "![](file:///abs/b%20c.png)",
            "and",
            "",
            `Relative ![](out/d.png), then ![dot](${dot}).`,
          ].join("\n"),
        ),
      );
      expect(sources).toEqual([
        "/abs/a.png",
        "/abs/b c.png",
        "/work/project/out/d.png",
      ]);
      const bunny = byLabel("Bunny")!;
      expect(bunny.querySelector("img")?.getAttribute("src")).toBe(
        "svode-media://localhost/token:/abs/a.png",
      );
      expect(bunny.closest("p")).toBe(null);
      const paragraphs = Array.from(doc.querySelectorAll("p")).map(
        (paragraph) => paragraph.textContent,
      );
      expect(paragraphs).toEqual(["Here is", "and", "Relative", ", then", "."]);
      // Two images with only a line break between them show together.
      const pair = bunny.closest("[data-media-layout]");
      expect(pair?.getAttribute("data-media-layout")).toBe("pair");
      expect(pair?.querySelectorAll("img").length).toBe(2);

      await click(bunny);
      expect(opened).toEqual(["/abs/a.png"]);

      const data = byLabel("dot")!;
      expect(data.querySelector("img")?.getAttribute("src")).toBe(dot);
      await click(data);
      expect(saved.length).toBe(1);
      expect(shellOpened).toEqual(["/tmp/svode-pasted/dot.png"]);
      expect(fetches).toBe(0);
    } finally {
      await unmountAll();
      sources.length = 0;
      opened.length = 0;
      shellOpened.length = 0;
      loads.length = 0;
    }
  });

  test("MEDIA lines show at their place: in quotes and backticks, not in code, markers hidden", async () => {
    try {
      await render(
        tree(
          [
            "Done.",
            'MEDIA:"/abs/two words.png"',
            "Voice: MEDIA:`~/voice.wav` [[audio_as_voice]]",
            "MEDIA:/abs/report.pdf [[as_document]]",
            "Run `MEDIA:/abs/code.png` to attach.",
            "```",
            "MEDIA:/abs/fenced.png",
            "```",
          ].join("\n"),
        ),
      );
      expect(sources.sort()).toEqual([
        "/Users/me/voice.wav",
        "/abs/two words.png",
      ]);
      expect(Boolean(byLabel("two words.png"))).toBe(true);
      expect(doc.querySelector("audio")?.getAttribute("src")).toBe(
        "svode-media://localhost/token:/Users/me/voice.wav",
      );
      const report = byLabel("report.pdf")!;
      expect(
        report.closest("[data-slot=attachment]")?.textContent?.includes("PDF"),
      ).toBe(true);

      const text = doc.body.textContent ?? "";
      expect(text.includes("[[audio_as_voice]]")).toBe(false);
      expect(text.includes("[[as_document]]")).toBe(false);
      expect(text.includes("MEDIA:/abs/two")).toBe(false);
      const code = doc.querySelector('[data-streamdown="inline-code"]');
      expect(code?.textContent).toBe("MEDIA:/abs/code.png");
      expect(text.includes("MEDIA:/abs/fenced.png")).toBe(true);
    } finally {
      await unmountAll();
      sources.length = 0;
    }
  });

  test("a MEDIA line split by the stream becomes a tile once it is whole", async () => {
    try {
      const root = await render(tree("Look:\nMEDIA:/abs/pi", true));
      expect(doc.querySelector("[data-chat-media]")).toBe(null);
      await act(async () =>
        root.render(tree("Look:\nMEDIA:/abs/pic.png", true)),
      );
      await settle();
      expect(doc.querySelector("[data-chat-media]")).toBe(null);
      await act(async () =>
        root.render(tree("Look:\nMEDIA:/abs/pic.png\nMore", true)),
      );
      await settle();
      expect(Boolean(byLabel("pic.png"))).toBe(true);
      // Nothing was read for the half of the path.
      expect(sources).toEqual(["/abs/pic.png"]);
      expect((doc.body.textContent ?? "").includes("MEDIA:")).toBe(false);
    } finally {
      await unmountAll();
      sources.length = 0;
    }
  });

  test("an external image is a card that loads nothing until Show, then a tile while the timeline is open", async () => {
    const url = "https://cdn.example.com/a/logo.png?size=2";
    const text = `Logo: ![logo](${url})`;
    const timeline = (owner: string, shown: boolean) => (
      <RevealedImagesProvider owner={owner}>
        {shown && tree(text)}
      </RevealedImagesProvider>
    );
    try {
      const root = await render(timeline("codex:s1", true));
      const card = doc.querySelector<HTMLElement>(
        `[data-external-image="${url}"]`,
      )!;
      expect(
        (card.textContent ?? "").includes(
          m.sessions_chat_external_image({ host: "cdn.example.com" }),
        ),
      ).toBe(true);
      expect(card.closest("p")).toBe(null);
      expect(doc.querySelector("img")).toBe(null);
      expect(loads).toEqual([]);
      expect(fetches).toBe(0);
      expect(await hover(card)).toBe(url);
      expect(loads).toEqual([]);

      await click(buttonByText(m.sessions_chat_external_image_show()));
      expect(loads[0]).toEqual({ src: url, referrerPolicy: "no-referrer" });
      const tile = byLabel("logo")!;
      const image = tile.querySelector("img")!;
      expect(image.getAttribute("src")).toBe(url);
      expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(doc.querySelector("[data-external-image]")).toBe(null);
      await click(tile);
      expect(shellOpened).toEqual([url]);

      // The message mounts again in the same timeline: still shown.
      await act(async () => root.render(timeline("codex:s1", false)));
      await act(async () => root.render(timeline("codex:s1", true)));
      await settle();
      expect(Boolean(byLabel("logo"))).toBe(true);

      // Another timeline, as after reopening the session: the card again.
      await unmountAll();
      loads.length = 0;
      await render(timeline("codex:s1", true));
      expect(Boolean(doc.querySelector("[data-external-image]"))).toBe(true);
      expect(doc.querySelector("img")).toBe(null);
      expect(loads).toEqual([]);
    } finally {
      await unmountAll();
      loads.length = 0;
      shellOpened.length = 0;
    }
  });

  test("an external image that fails to load is the card with the reason and its address", async () => {
    const url = "https://broken.example.org/x.png";
    failing.add(url);
    try {
      await render(
        <RevealedImagesProvider owner="codex:s1">
          {tree(`![](${url})`)}
        </RevealedImagesProvider>,
      );
      await click(buttonByText(m.sessions_chat_external_image_show()));
      const card = doc.querySelector<HTMLElement>(
        `[data-external-image="${url}"]`,
      )!;
      expect(
        card
          .querySelector("[data-slot=attachment]")
          ?.getAttribute("data-state"),
      ).toBe("error");
      expect(
        (card.textContent ?? "").includes(
          m.sessions_chat_external_image_failed(),
        ),
      ).toBe(true);
      expect(await hover(card)).toBe(url);
      expect(doc.querySelector("img")).toBe(null);
    } finally {
      await unmountAll();
      failing.clear();
      loads.length = 0;
    }
  });

  test("a local image too large to show offers its app", async () => {
    try {
      await render(tree("![](/abs/huge.png)"));
      const large = doc.querySelector("[data-media-state=too_large]")!;
      expect(
        (large.textContent ?? "").includes(m.sessions_chat_media_too_large()),
      ).toBe(true);
      await click(buttonByText(m.sessions_chat_media_open_in_app()));
      expect(shellOpened).toEqual(["/abs/huge.png"]);
    } finally {
      await unmountAll();
      shellOpened.length = 0;
      sources.length = 0;
    }
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    PointerEvent: dom.window.MouseEvent,
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
