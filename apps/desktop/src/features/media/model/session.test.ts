import { expect, test } from "bun:test";

import { DEFAULT_MEDIA_VIEW_STATE } from "./types";
import { MediaRuntimeSession, mediaSessionCoordinator } from "./session";

test("activating a Media target destroys the previous renderer before source", async () => {
  mediaSessionCoordinator.resetForTests();
  const order: string[] = [];
  const first = new MediaRuntimeSession(1, "space\0first.png");
  first.addDisposer(() => {
    order.push("source");
  });
  first.addDisposer(() => {
    order.push("renderer");
  });
  const second = new MediaRuntimeSession(2, "space\0second.png");

  expect(await mediaSessionCoordinator.activate(first)).toBe(true);
  expect(await mediaSessionCoordinator.activate(second)).toBe(true);
  expect(order).toEqual(["renderer", "source"]);
  await mediaSessionCoordinator.release(second);
});

test("Peek handoff transfers image view state once after destroying the source", async () => {
  mediaSessionCoordinator.resetForTests();
  const peek = new MediaRuntimeSession(1, "space\0photo.png");
  peek.setViewState({
    ...DEFAULT_MEDIA_VIEW_STATE,
    mode: "custom",
    panX: 40,
    panY: 80,
    playback: {
      currentTime: 42,
      muted: true,
      playbackRate: 1.25,
      volume: 0.4,
    },
    zoom: 1.5,
  });
  expect(await mediaSessionCoordinator.activate(peek)).toBe(true);
  await mediaSessionCoordinator.handoff(peek);
  expect(peek.signal.aborted).toBe(true);

  const full = new MediaRuntimeSession(2, "space\0photo.png");
  expect(await mediaSessionCoordinator.activate(full)).toBe(true);
  expect(full.getViewState()).toEqual({
    mode: "custom",
    panX: 40,
    panY: 80,
    playback: {
      currentTime: 42,
      muted: true,
      playbackRate: 1.25,
      volume: 0.4,
    },
    zoom: 1.5,
  });

  const reopened = new MediaRuntimeSession(3, "space\0photo.png");
  expect(await mediaSessionCoordinator.activate(reopened)).toBe(true);
  expect(reopened.getViewState().mode).toBe("fit");
  expect(reopened.getViewState().playback.currentTime).toBe(0);
  await mediaSessionCoordinator.release(reopened);
});

test("external open suspension pauses motion without revoking the session", async () => {
  const session = new MediaRuntimeSession(1, "space\0motion.gif");
  let pauses = 0;
  session.addExternalSuspender(() => {
    pauses += 1;
  });
  await session.suspendForExternalOpen();
  expect(pauses).toBe(1);
  expect(session.signal.aborted).toBe(false);
  await session.destroy();
});

test("renderer cleanup failure does not prevent source revocation", async () => {
  const order: string[] = [];
  const session = new MediaRuntimeSession(1, "space\0playback.mp4");
  session.addDisposer(() => {
    order.push("source");
  });
  session.addDisposer(() => {
    order.push("renderer");
    throw new Error("fixture cleanup failure");
  });
  await session.destroy();
  expect(order).toEqual(["renderer", "source"]);
});

test("repeated open and close destroys every Media session", async () => {
  mediaSessionCoordinator.resetForTests();
  const sessions = Array.from(
    { length: 8 },
    (_, index) => new MediaRuntimeSession(index, `space\0${index}.png`),
  );
  for (const session of sessions) {
    expect(await mediaSessionCoordinator.activate(session)).toBe(true);
    await mediaSessionCoordinator.release(session);
  }
  expect(sessions.every((session) => session.signal.aborted)).toBe(true);
});
