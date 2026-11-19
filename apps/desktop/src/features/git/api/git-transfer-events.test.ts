import { afterEach, expect, test } from "bun:test";
import type { GitTransferProgressDto } from "@/platform/git/git-types";
import { useGitStore } from "../model";
import { createGitTransferRecorder } from "./git-transfer-events";

const repository = "/projects/notes";
const progress = (bytes: number): GitTransferProgressDto => ({
  direction: "upload",
  file: 1,
  files: 2,
  path: "media/video.mov",
  bytes,
  size: 99_614_720,
});
const shown = () => useGitStore.getState().transfers[repository];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => useGitStore.getState().setTransfer(repository, null));

test("a transfer shorter than the threshold shows nothing", async () => {
  const recorder = createGitTransferRecorder(40);
  recorder.record({ repository, progress: progress(1) });
  recorder.record({ repository, progress: progress(2) });
  recorder.record({ repository, progress: null });
  await wait(80);
  expect(shown()).toBeUndefined();
  recorder.dispose();
});

test("a longer transfer shows its latest progress after the threshold until it ends", async () => {
  const recorder = createGitTransferRecorder(40);
  recorder.record({ repository, progress: progress(1) });
  await wait(10);
  recorder.record({ repository, progress: progress(2) });
  expect(shown()).toBeUndefined();
  await wait(60);
  expect(shown()?.bytes).toBe(2);
  recorder.record({ repository, progress: progress(3) });
  expect(shown()?.bytes).toBe(3);
  expect(shown()?.path).toBe("media/video.mov");
  recorder.record({ repository, progress: null });
  expect(shown()).toBeUndefined();

  // The next transfer of the repository waits for the threshold again.
  recorder.record({ repository, progress: progress(4) });
  expect(shown()).toBeUndefined();
  await wait(60);
  expect(shown()?.bytes).toBe(4);
  recorder.dispose();
  expect(shown()).toBeUndefined();
});

test("each repository has its own transfer", async () => {
  const recorder = createGitTransferRecorder(20);
  const space = "/projects/notes/media";
  recorder.record({ repository, progress: progress(1) });
  recorder.record({
    repository: space,
    progress: { ...progress(5), direction: "download" },
  });
  await wait(50);
  recorder.record({ repository, progress: null });
  expect(shown()).toBeUndefined();
  expect(useGitStore.getState().transfers[space]?.direction).toBe("download");
  recorder.dispose();
  expect(useGitStore.getState().transfers[space]).toBeUndefined();
});
