import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useContext, useEffect, useState } from "react";
import type { HeldMedia } from "@/features/media/app-shell";
import type { SpaceInfo } from "@/features/space";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_CHAT_MEDIA_PEEK_DOM !== "1") {
  test("chat media outside the project opens in the media peek", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CHAT_MEDIA_PEEK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = await createTestDom();
  const doc = dom.document;
  window.HTMLElement.prototype.scrollTo = () => {};
  const PREVIEW = {
    id: "com.apple.Preview",
    label: "Preview",
    kind: "application",
    isDefault: true,
    icon: null,
  };
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const FAMILY: Record<string, ["image" | "video" | "audio", string]> = {
    png: ["image", "image/png"],
    mp4: ["video", "video/mp4"],
    mp3: ["audio", "audio/mpeg"],
  };
  let token = 0;
  mockNativeIpc(
    (command, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      calls.push({ command, args });
      if (command === "media_create_local_source") {
        const format = String(args.path).split(".").at(-1)!;
        const [family, mimeType] = FAMILY[format]!;
        token += 1;
        return {
          animated: false,
          capabilityToken: `token-${token}`,
          family,
          format,
          generation: "g1",
          height: family === "image" ? 48 : null,
          inlinePreview: family === "image",
          intrinsicOversized: false,
          mimeType,
          requiresRangeRequests: false,
          sizeBytes: 2048,
          width: family === "image" ? 64 : null,
        };
      }
      if (command === "media_local_list_external_apps") return [PREVIEW];
      if (
        command === "media_local_open_external" ||
        command === "media_local_reveal_external" ||
        command === "media_revoke_source" ||
        command === "plugin:shell|open"
      )
        return null;
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected IPC: ${command}`);
    },
    { shouldMockEvents: true },
  );
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, protocol: string) => string;
      };
    }
  ).__TAURI_INTERNALS__.convertFileSrc = (path, protocol) =>
    `${protocol}://localhost/${path}`;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const m = await import("@/paraglide/messages.js");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { Sheet, SheetContent, SheetTitle } =
    await import("@/components/ui/sheet");
  const { ChatAttachmentOpenerContext, ChatHeldMediaOpenerContext } =
    await import("@/features/agent-sessions");
  const { registerRootSpace } = await import("@/features/space");
  const { usePeekStackEntry } =
    await import("@/shared/hooks/use-peek-stack-entry");
  const { closeTopPeek } = await import("@/shared/lib/peek-stack");
  const { ChatAttachmentPeekProvider } = await import("./chat-attachment-peek");

  registerRootSpace({
    id: "root",
    name: "Project",
    path: "/project",
  } as SpaceInfo);

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 10; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  async function click(element: HTMLElement) {
    await act(async () => element.click());
    await settle();
  }
  async function pressEscape(element: HTMLElement) {
    await act(async () => {
      element.focus();
      element.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
  }
  const commands = (name: string) =>
    calls.filter((call) => call.command === name).map((call) => call.args);
  const sheets = () => doc.querySelectorAll('[data-slot="sheet-content"]');
  const mediaPeek = () =>
    [...sheets()].find((sheet) => sheet.querySelector("[data-peek-top-bar]"));
  const identity = () =>
    mediaPeek()?.querySelector("[data-peek-identity]")?.textContent;

  let open: ((attachment: { path: string; name: string }) => void) | null =
    null;
  let openHeld: ((media: HeldMedia) => void) | null = null;
  function Opener() {
    const opener = useContext(ChatAttachmentOpenerContext);
    const heldOpener = useContext(ChatHeldMediaOpenerContext);
    useEffect(() => {
      open = opener;
      openHeld = heldOpener;
    });
    return null;
  }

  /** Media the chat holds, recording what the viewer does with it. */
  function heldMedia(
    overrides: Partial<HeldMedia> & {
      content?: Awaited<ReturnType<HeldMedia["load"]>>;
    } = {},
  ) {
    const log: string[] = [];
    const { content, ...rest } = overrides;
    const media: HeldMedia = {
      key: "m1:image",
      name: "image.png",
      family: "image",
      load: async () => {
        log.push("load");
        return (
          content ?? {
            url: "blob:http://localhost/held-image",
            mimeType: "image/png",
            sizeBytes: 4,
            release: () => log.push("release"),
          }
        );
      },
      action: {
        kind: "app",
        label: m.sessions_chat_media_open_in_app(),
        run: async () => {
          log.push("open in app");
        },
      },
      ...rest,
    };
    return { media, log };
  }
  async function openHeldMedia(media: HeldMedia) {
    await act(async () => openHeld!(media));
    await settle();
  }
  const heldAction = () =>
    mediaPeek()?.querySelector<HTMLElement>("[data-held-media-action]");
  async function openAttachment(path: string) {
    await act(async () =>
      open!({ path, name: path.split("/").at(-1) ?? path }),
    );
    await settle();
  }

  /** The session peek: a sheet on the peek stack with the chat inside. */
  function SessionPeek() {
    const [opened, setOpened] = useState(true);
    usePeekStackEntry(opened, () => setOpened(false));
    return (
      <Sheet open={opened} onOpenChange={setOpened}>
        <SheetContent data-session-peek>
          <SheetTitle>Session</SheetTitle>
          <Opener />
        </SheetContent>
      </Sheet>
    );
  }

  test("an image, a video and an audio outside the project open in the media peek, not in their app", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    // A generated image, a pasted image of the OS temp folder, a video, an audio.
    for (const path of [
      "/Users/me/.codex/generated/photo.png",
      "/var/folders/ab/T/svode-pasted/pasted.png",
      "/tmp/out/clip.mp4",
      "/tmp/out/voice.mp3",
    ]) {
      calls.length = 0;
      await openAttachment(path);
      const name = path.split("/").at(-1)!;
      // One media: its name, no Changes, no Expand, no counter.
      expect(identity()).toBe(name);
      expect(commands("media_create_local_source")).toEqual([{ path }]);
      expect(commands("plugin:shell|open")).toEqual([]);
      expect(commands("media_create_source")).toEqual([]);
      expect(
        mediaPeek()!.querySelector(`[aria-label="${m.peek_expand()}"]`),
      ).toBeNull();
      expect(mediaPeek()!.querySelector("[data-changes-trigger]")).toBeNull();

      // Closing revokes the capability of the file.
      await click(
        mediaPeek()!.querySelector<HTMLElement>(
          `[aria-label="${m.peek_close()}"]`,
        )!,
      );
      expect(mediaPeek()).toBe(undefined);
      expect(commands("media_revoke_source")).toEqual([
        { capabilityToken: `token-${token}` },
      ]);
    }
    await dom.render(null);
  });

  test("Open with launches the default app and Show in Finder reveals the file by its path", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    const path = "/tmp/out/photo.png";
    calls.length = 0;
    await openAttachment(path);
    const primary = mediaPeek()!.querySelector<HTMLElement>(
      "[data-external-open-primary]",
    )!;
    expect(primary.getAttribute("aria-label")).toBe("Open in Preview");
    await click(primary);
    expect(commands("media_local_open_external")).toEqual([
      { path, appId: PREVIEW.id },
    ]);
    // Nothing else opens the file on its own.
    expect(commands("plugin:shell|open")).toEqual([]);

    const chevron = mediaPeek()!.querySelector<HTMLElement>(
      `[aria-label="${m.external_open_with()}"]`,
    )!;
    await act(async () => {
      chevron.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
    await click(doc.querySelector<HTMLElement>("[data-external-open-reveal]")!);
    expect(commands("media_local_reveal_external")).toEqual([{ path }]);
    // The peek stays open after an action.
    expect(identity()).toBe("photo.png");
    await dom.render(null);
  });

  test("a document, a folder and a network path outside the project open in the system as before", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    calls.length = 0;
    for (const path of [
      "/tmp/out/report.pdf",
      "/tmp/out/notes.txt",
      "/tmp/out/folder",
      "//server/share/photo.png",
    ]) {
      await openAttachment(path);
      expect(sheets().length).toBe(0);
    }
    expect(commands("plugin:shell|open").map((args) => args.path)).toEqual([
      "/tmp/out/report.pdf",
      "/tmp/out/notes.txt",
      "/tmp/out/folder",
      "//server/share/photo.png",
    ]);
    expect(commands("media_create_local_source")).toEqual([]);
    await dom.render(null);
  });

  test("media without a file opens in the media peek from the memory of the window, its app only by Open in app", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    calls.length = 0;
    const { media, log } = heldMedia();
    await openHeldMedia(media);
    // One media by its name, read once, nothing asked of Desktop.
    expect(identity()).toBe("image.png");
    expect(log).toEqual(["load"]);
    expect(mediaPeek()!.querySelector("img")?.getAttribute("src")).toBe(
      "blob:http://localhost/held-image",
    );
    expect(
      calls.filter((call) => !call.command.startsWith("plugin:event|")),
    ).toEqual([]);
    expect(
      mediaPeek()!.querySelector(`[aria-label="${m.peek_expand()}"]`),
    ).toBeNull();
    expect(mediaPeek()!.querySelector("[data-changes-trigger]")).toBeNull();

    // One action, without a list of applications or Finder.
    const action = heldAction()!;
    expect(action.getAttribute("data-held-media-action")).toBe("app");
    expect(action.getAttribute("aria-label")).toBe(
      m.sessions_chat_media_open_in_app(),
    );
    expect(
      mediaPeek()!.querySelector(`[aria-label="${m.external_open_with()}"]`),
    ).toBeNull();
    await click(action);
    expect(log).toEqual(["load", "open in app"]);
    expect(identity()).toBe("image.png");

    // Closing frees the data.
    await click(
      mediaPeek()!.querySelector<HTMLElement>(
        `[aria-label="${m.peek_close()}"]`,
      )!,
    );
    expect(mediaPeek()).toBe(undefined);
    expect(log).toEqual(["load", "open in app", "release"]);
    expect(
      calls.filter((call) => !call.command.startsWith("plugin:event|")),
    ).toEqual([]);
    await dom.render(null);
  });

  test("a shown external image loads without a referrer and opens in the browser only by its action", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    const url = "https://cdn.example.com/a/logo.png";
    const { media, log } = heldMedia({
      key: url,
      name: "logo",
      content: { url, remote: true, mimeType: null, sizeBytes: null },
      action: {
        kind: "browser",
        label: m.sessions_chat_media_open_in_browser(),
        run: async () => {
          log.push("browser");
        },
      },
    });
    await openHeldMedia(media);
    expect(identity()).toBe("logo");
    const image = mediaPeek()!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(url);
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.hasAttribute("crossorigin")).toBe(false);
    const action = heldAction()!;
    expect(action.getAttribute("aria-label")).toBe(
      m.sessions_chat_media_open_in_browser(),
    );
    await click(action);
    expect(log).toEqual(["load", "browser"]);
    await dom.render(null);
  });

  test("data the runtime let go shows its reason without a way out", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <Opener />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    const reason = m.sessions_chat_media_released();
    const { media } = heldMedia({ content: { unavailable: reason } });
    await openHeldMedia(media);
    const text = mediaPeek()!.textContent ?? "";
    expect(text.includes(m.media_unavailable_title())).toBe(true);
    expect(text.includes(reason)).toBe(true);
    expect(heldAction() ?? null).toBeNull();
    expect(text.includes(m.attachments_retry())).toBe(false);
    await dom.render(null);
  });

  test("from the session peek held media opens as its child: Esc closes only it and frees the data", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <SessionPeek />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    await settle();
    const { media, log } = heldMedia();
    await openHeldMedia(media);
    expect(identity()).toBe("image.png");
    await pressEscape(heldAction()!);
    expect(mediaPeek()).toBe(undefined);
    expect(Boolean(doc.querySelector("[data-session-peek]"))).toBe(true);
    expect(log).toEqual(["load", "release"]);
    await dom.render(null);
  });

  test("from the session peek the media peek is its child: Esc and ⌘W close only it", async () => {
    await dom.render(
      <TooltipProvider>
        <ChatAttachmentPeekProvider>
          <SessionPeek />
        </ChatAttachmentPeekProvider>
      </TooltipProvider>,
    );
    await settle();
    const path = "/tmp/out/photo.png";
    calls.length = 0;
    await openAttachment(path);
    expect(identity()).toBe("photo.png");
    expect(Boolean(doc.querySelector("[data-session-peek]"))).toBe(true);

    await pressEscape(
      mediaPeek()!.querySelector<HTMLElement>(
        `[aria-label="${m.peek_close()}"]`,
      )!,
    );
    expect(mediaPeek()).toBe(undefined);
    expect(Boolean(doc.querySelector("[data-session-peek]"))).toBe(true);
    expect(commands("media_revoke_source").length).toBe(1);

    await openAttachment(path);
    expect(identity()).toBe("photo.png");
    await act(async () => {
      closeTopPeek();
    });
    await settle();
    expect(mediaPeek()).toBe(undefined);
    expect(Boolean(doc.querySelector("[data-session-peek]"))).toBe(true);
    expect(commands("media_revoke_source").length).toBe(2);

    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  });
}
