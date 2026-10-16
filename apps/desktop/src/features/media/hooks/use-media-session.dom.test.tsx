import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";

import { createTestDom } from "@/shared/testing/dom";

import type { MediaSourceDescriptor, MediaTarget } from "../model/types";

if (process.env.SVODE_MEDIA_SESSION_DOM !== "1") {
  test("media session checks the generation on invalidation", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_MEDIA_SESSION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };

  interface Deferred {
    resolve(): void;
    reject(error: unknown): void;
  }

  const checks: Array<Deferred & { generation: string }> = [];
  const listeners = new Set<() => void>();
  const released: string[] = [];
  let opened = 0;
  let sourceGate: Promise<void> | null = null;

  function descriptor(token: string): MediaSourceDescriptor {
    return {
      animated: false,
      capabilityToken: token,
      family: "video",
      format: "mp4",
      generation: "g1",
      height: 720,
      inlinePreview: true,
      intrinsicOversized: false,
      mimeType: "video/mp4",
      requiresRangeRequests: true,
      sizeBytes: 1024,
      sourceUrl: `svode-media://localhost/${token}`,
      width: 1280,
    };
  }

  mock.module("../api/media-api", () => ({
    checkMediaSource: (_target: MediaTarget, generation: string) =>
      new Promise<void>((resolve, reject) => {
        checks.push({ generation, reject, resolve });
      }),
    loadMediaSource: async () => {
      await sourceGate;
      opened += 1;
      return descriptor(`t${opened}`);
    },
    mediaExternalOpenTarget: () => ({
      listApps: async () => [],
      open: async () => undefined,
      preferenceKey: "mp4",
    }),
    releaseMediaSource: async (token: string) => {
      released.push(token);
    },
    subscribeMediaInvalidated: async (
      _target: MediaTarget,
      handler: () => void,
    ) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  }));

  const { useMediaSession } = await import("./use-media-session");
  const { mediaSessionCoordinator } = await import("../model/session");
  type Session = ReturnType<typeof useMediaSession>;

  const dom = await createTestDom();
  let session: Session | null = null;

  function Harness({ target }: { target: MediaTarget }) {
    const latest = useMediaSession(target);
    useEffect(() => {
      session = latest;
    });
    return null;
  }

  function current() {
    return session!;
  }

  function failureKind() {
    const { state } = current();
    return state.phase === "failed" ? state.failure.kind : null;
  }

  function source() {
    const { state } = current();
    if (state.phase !== "loading" && state.phase !== "ready") {
      throw new Error(`No source in ${state.phase}`);
    }
    return state.source;
  }

  async function settle() {
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  function invalidate() {
    for (const listener of listeners) listener();
  }

  function target(path = "media/clip.mp4"): MediaTarget {
    return {
      path,
      projectPath: "/work/project",
      spaceId: null,
      spacePath: "/work/project",
    };
  }

  async function open(mediaTarget = target()) {
    mediaSessionCoordinator.resetForTests();
    checks.length = 0;
    released.length = 0;
    await dom.render(<Harness target={mediaTarget} />);
    await settle();
  }

  async function markReady() {
    await act(async () => current().markReady(source()));
  }

  const changed = { kind: "source_changed" };

  test("an unchanged generation keeps loading and ready playback and its view", async () => {
    await open();
    expect(current().state.phase).toBe("loading");
    const token = source().capabilityToken;

    invalidate();
    await settle();
    expect(checks.map((check) => check.generation).join()).toBe("g1");
    checks[0]!.resolve();
    await settle();
    expect(current().state.phase).toBe("loading");

    await markReady();
    const ready = current().state;
    await act(async () => {
      current().updateViewState((view) => ({
        ...view,
        playback: { ...view.playback, currentTime: 42, playbackRate: 1.5 },
      }));
    });
    invalidate();
    await settle();
    checks[1]!.resolve();
    await settle();

    expect(current().state === ready).toBe(true);
    expect(source().capabilityToken).toBe(token);
    expect(released.includes(token)).toBe(false);
    expect(current().viewState.playback.currentTime).toBe(42);
    expect(current().viewState.playback.playbackRate).toBe(1.5);
  });

  test("a changed generation and a missing file end the session", async () => {
    await open();
    await markReady();
    const token = source().capabilityToken;
    invalidate();
    await settle();
    checks[0]!.reject(changed);
    await settle();
    expect(failureKind()).toBe("source_changed");
    expect(released.includes(token)).toBe(true);

    // A failed session no longer checks.
    invalidate();
    await settle();
    expect(checks.length).toBe(1);

    await open(target("media/other.mp4"));
    invalidate();
    await settle();
    checks[0]!.reject({ kind: "source_missing" });
    await settle();
    expect(failureKind()).toBe("source_missing");
  });

  test("an event before the generation is known does not fail the load", async () => {
    let release = () => {};
    sourceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await open(target("media/early.mp4"));
      expect(current().state.phase).toBe("resolving");
      invalidate();
      await settle();
      expect(checks.length).toBe(0);
      release();
      await settle();
      expect(current().state.phase).toBe("loading");
      expect(checks.length).toBe(0);
    } finally {
      sourceGate = null;
    }
  });

  test("a check result after Retry or another target is dropped", async () => {
    await open(target("media/retry.mp4"));
    invalidate();
    await settle();
    await act(async () => current().retry());
    await settle();
    expect(current().state.phase).toBe("loading");
    checks[0]!.reject(changed);
    await settle();
    expect(current().state.phase).toBe("loading");

    invalidate();
    await settle();
    expect(checks.length).toBe(2);
    await dom.render(<Harness target={target("media/next.mp4")} />);
    await settle();
    checks[1]!.reject(changed);
    await settle();
    expect(current().state.phase).toBe("loading");
  });

  test("events during a check are checked after it", async () => {
    await open(target("media/twice.mp4"));
    await markReady();
    invalidate();
    await settle();
    invalidate();
    await settle();
    expect(checks.length).toBe(1);
    checks[0]!.resolve();
    await settle();
    expect(checks.length).toBe(2);
    checks[1]!.resolve();
    await settle();
    expect(current().state.phase).toBe("ready");

    // The file changes between the two events: the later check decides.
    invalidate();
    await settle();
    invalidate();
    await settle();
    checks[2]!.resolve();
    await settle();
    expect(current().state.phase).toBe("ready");
    checks[3]!.reject(changed);
    await settle();
    expect(failureKind()).toBe("source_changed");

    await dom.dispose();
  });
}
