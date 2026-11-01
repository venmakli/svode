import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_GIT_COMMITTED_DOM !== "1") {
  test("Git state signals during a refresh coalesce per kind", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_GIT_COMMITTED_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  // DF-289 R2: ten `git:committed` signals during a running refresh give one
  // current and one following refresh of each kind, however many hooks of
  // the Space listen.
  test("ten signals during a refresh give one current and one following refresh of each kind", async () => {
    const dom = await createTestDom();
    const path = "/project";
    const state = { activeRootPath: path };
    mock.module("@/features/space", () => ({
      selectActiveSpacePath: () => path,
      useSpace: (select: (value: typeof state) => unknown) => select(state),
    }));
    const status = {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [],
      hasStaged: false,
      hasUnstaged: false,
      hasConflicts: false,
      tracking: "origin/main",
      repository: path,
    };
    const replies: Record<string, unknown> = {
      status,
      stop: null,
      counters: status,
      counterStatus: status,
      publication: null,
    };
    const counts: Record<string, number> = {};
    const running: Record<string, number> = {};
    const mostRunning: Record<string, number> = {};
    const held: Array<() => void> = [];
    let hold = false;
    const kind = (command: string, args: Record<string, unknown>) => {
      if (command === "git_status")
        return args.remoteCounts ? "counterStatus" : "status";
      if (command === "git_sync_preflight") return "stop";
      if (command === "git_fetch_status") return "counters";
      if (command === "git_publication_status") return "publication";
      return null;
    };
    mockNativeIpc(
      (command, payload) => {
        const refresh = kind(
          command,
          (payload ?? {}) as Record<string, unknown>,
        );
        if (refresh) {
          counts[refresh] = (counts[refresh] ?? 0) + 1;
          if (!hold) return replies[refresh];
          running[refresh] = (running[refresh] ?? 0) + 1;
          mostRunning[refresh] = Math.max(
            mostRunning[refresh] ?? 0,
            running[refresh],
          );
          return new Promise((resolve) => {
            held.push(() => {
              running[refresh]--;
              resolve(replies[refresh]);
            });
          });
        }
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/repo.git";
        return null;
      },
      { shouldMockEvents: true },
    );
    const { useGitWatch } = await import("./use-git-watch");
    const { useGitSyncWidget } = await import("./use-git-sync-widget");
    const { useGitStore } = await import("../model/git-store");
    const { emit } = await import("@/platform/native/events");
    function Probe() {
      // The project row and the app shell both watch the Space.
      useGitWatch(path);
      useGitWatch(path);
      useGitSyncWidget(path);
      return null;
    }
    const settle = () =>
      act(async () => {
        for (let turn = 0; turn < 5; turn++)
          await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const release = async () => {
      await act(async () => {
        for (const resolve of held.splice(0)) resolve();
      });
      await settle();
    };
    const signal = () =>
      act(async () => {
        await emit("git:committed", { spacePath: path, repoPath: path });
      });
    try {
      await dom.render(<Probe />);
      await settle();
      for (const key of Object.keys(counts)) delete counts[key];

      hold = true;
      await signal();
      await settle();
      const current = { status: 1, stop: 1, counters: 1, publication: 1 };
      expect(counts).toEqual(current);
      for (let index = 0; index < 9; index++) await signal();
      await settle();
      expect(counts).toEqual(current);

      // The running refreshes end: one following refresh of each kind,
      // never two of a kind at once.
      for (let round = 0; round < 4; round++) await release();
      const { counterStatus = 0, ...refreshes } = counts;
      expect(refreshes).toEqual({
        status: 2,
        stop: 2,
        counters: 2,
        publication: 2,
      });
      // A counters read while a status changed rereads it locally.
      expect(counterStatus <= 2).toBe(true);
      expect(Object.values(mostRunning).every((most) => most === 1)).toBe(true);
    } finally {
      hold = false;
      for (const resolve of held.splice(0)) resolve();
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear(path);
      await dom.dispose();
    }
  });
}
