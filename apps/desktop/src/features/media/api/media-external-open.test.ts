import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

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
