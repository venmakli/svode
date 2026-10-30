import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { MediaSourceSessionDto } from "@/platform/media/media-api";
import { invokeCommand } from "@/platform/native/invoke";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { mediaExternalOpenTarget } from "./media-api";

test("media pauses before opening in any application, not before reveal", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new JSDOM("", { url: "http://localhost/" }).window,
  });
  const steps: string[] = [];
  mockNativeIpc((command, args) => {
    steps.push(`${command}:${JSON.stringify(args)}`);
    return null;
  });
  const target = mediaExternalOpenTarget(
    {
      path: "clips/Intro.MOV",
      projectPath: "/work/project",
      spaceId: null,
      spacePath: "/work/project",
    },
    {
      beforeOpen: async () => {
        steps.push("pause");
      },
      onAttempt: () => steps.push("attempt"),
    },
  );
  const input =
    '"projectPath":"/work/project","spaceId":null,"targetPath":"clips/Intro.MOV"';

  expect(target.preferenceKey).toBe("file:mov");
  await target.open("org.videolan.vlc");
  await target.open(null);
  await target.reveal?.();

  expect(steps).toEqual([
    "attempt",
    "pause",
    `media_open_external:{${input},"appId":"org.videolan.vlc"}`,
    "attempt",
    "pause",
    `media_open_external:{${input},"appId":null}`,
    "attempt",
    `media_reveal_external:{${input}}`,
  ]);
  clearNativeMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});

test("a file outside the Space loads and opens through its owner", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new JSDOM("", { url: "http://localhost/" }).window,
  });
  const steps: string[] = [];
  mockNativeIpc((command, args) => {
    steps.push(`${command}:${JSON.stringify(args)}`);
    if (command === "agent_context_create_skill_media_source") {
      return {
        animated: false,
        capabilityToken: "token",
        family: "image",
        format: "png",
        generation: "g1",
        height: 1,
        inlinePreview: true,
        intrinsicOversized: false,
        mimeType: "image/png",
        requiresRangeRequests: false,
        sizeBytes: 4,
        width: 1,
      };
    }
    return null;
  });
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        convertFileSrc(path: string, protocol: string): string;
      };
    }
  ).__TAURI_INTERNALS__.convertFileSrc = (path, protocol) =>
    `${protocol}://localhost/${path}`;
  const { checkMediaSource, loadMediaSource, subscribeMediaInvalidated } =
    await import("./media-api");
  const target = {
    createSource: () =>
      invokeCommand<MediaSourceSessionDto>(
        "agent_context_create_skill_media_source",
        { itemId: "skill:review", path: "assets/logo.png" },
      ),
    externalOpen: {
      listApps: async () => [],
      open: async (appId: string | null) => {
        steps.push(`owner-open:${appId}`);
      },
      preferenceKey: "file:png",
      reveal: async () => {
        steps.push("owner-reveal");
      },
    },
    kind: "local" as const,
    path: "/home/user/.claude/skills/review/assets/logo.png",
  };

  const { source } = await loadMediaSource(target);
  await checkMediaSource(target, "other");
  const unlisten = await subscribeMediaInvalidated(target, () => undefined);
  unlisten();
  const open = mediaExternalOpenTarget(target, {
    beforeOpen: async () => {
      steps.push("pause");
    },
    onAttempt: () => steps.push("attempt"),
  });
  await open.open("preview");
  await open.reveal?.();

  expect(source.capabilityToken).toBe("token");
  expect(steps).toEqual([
    'agent_context_create_skill_media_source:{"itemId":"skill:review","path":"assets/logo.png"}',
    "attempt",
    "pause",
    "owner-open:preview",
    "attempt",
    "owner-reveal",
  ]);
  clearNativeMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});
