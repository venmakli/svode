import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useContext, useEffect, useState } from "react";
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
  const { ChatAttachmentOpenerContext } =
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
  function Opener() {
    const opener = useContext(ChatAttachmentOpenerContext);
    useEffect(() => {
      open = opener;
    });
    return null;
  }
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
