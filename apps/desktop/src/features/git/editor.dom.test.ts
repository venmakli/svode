import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { mockNativeIpc, clearNativeMocks } from "@/platform/native/testing";
import * as m from "@/paraglide/messages.js";
import type { GitStatus } from "./model";

// Module mocks and the window global stay inside a child process.
if (process.env.SVODE_GIT_RESOLVE_TEST !== "1") {
  test("merge resolution from a saved Page", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_GIT_RESOLVE_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  });
} else {
  const toasts: { kind: string; message: unknown }[] = [];
  const mock = (
    bunTest as unknown as {
      mock: { module: (specifier: string, factory: () => unknown) => void };
    }
  ).mock;

  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toasts.push({ kind: "error", message }),
      info: (message: unknown) => toasts.push({ kind: "info", message }),
    },
  }));

  Object.defineProperty(globalThis, "window", {
    value: new JSDOM("<!doctype html>").window,
    configurable: true,
  });

  const { continueGitResolve } = await import("./editor");
  const { useGitStore } = await import("./model");

  const spacePath = "/project/space";

  function conflictStatus(files: string[]): GitStatus {
    return {
      branch: "main",
      ahead: 0,
      behind: 0,
      hasStaged: true,
      hasUnstaged: false,
      hasConflicts: files.length > 0,
      tracking: "origin/main",
      files: files.map((path) => ({ path, state: "conflict" as const })),
    };
  }

  test("saving a conflicted Page resolves only its path and reports the remaining files", async () => {
    const resolveArgs: unknown[] = [];
    const remaining = [".svode/order.json", "old.md"];
    toasts.length = 0;
    mockNativeIpc((command, args) => {
      if (command === "git_resolve_continue") {
        resolveArgs.push(args);
        return { type: "conflict", files: remaining };
      }
      if (command === "git_status") return conflictStatus(remaining);
      throw new Error(command);
    });
    try {
      useGitStore
        .getState()
        .applyStatus(spacePath, conflictStatus(["plan.md", ...remaining]));
      await continueGitResolve(spacePath, "plan.md", "Plan");
      expect(resolveArgs).toEqual([{ spacePath, paths: ["plan.md"] }]);
      expect(toasts).toEqual([
        {
          kind: "info",
          message: m.git_resolve_conflicts_remaining({
            page: "Plan",
            count: "2",
          }),
        },
      ]);
      const state = useGitStore.getState();
      expect(state.syncError[spacePath]).toBe("conflict");
      expect(state.statuses[spacePath]?.files.map((file) => file.path)).toEqual(
        remaining,
      );
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(spacePath);
    }
  });

  test("saving a Page outside the conflict keeps the merge and reports the sync conflict", async () => {
    const remaining = ["plan.md"];
    toasts.length = 0;
    mockNativeIpc((command) => {
      if (command === "git_resolve_continue")
        return { type: "conflict", files: remaining };
      if (command === "git_status") return conflictStatus(remaining);
      throw new Error(command);
    });
    try {
      useGitStore.getState().applyStatus(spacePath, conflictStatus(remaining));
      await continueGitResolve(spacePath, "notes.md", "Notes");
      expect(toasts).toEqual([
        { kind: "error", message: m.git_sync_conflict({ count: "1" }) },
      ]);
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(spacePath);
    }
  });

  test("resolving the last conflicted file without a merge commits nothing and stays quiet", async () => {
    const commands: string[] = [];
    toasts.length = 0;
    mockNativeIpc((command) => {
      commands.push(command);
      if (command === "git_resolve_continue") return { type: "resolved" };
      if (command === "git_status") return conflictStatus([]);
      throw new Error(command);
    });
    try {
      useGitStore.getState().applyStatus(spacePath, conflictStatus(["old.md"]));
      await continueGitResolve(spacePath, "old.md", "Old");
      expect(commands).toEqual(["git_resolve_continue", "git_status"]);
      expect(toasts).toEqual([]);
      const state = useGitStore.getState();
      expect(spacePath in state.syncError).toBe(false);
      expect(state.statuses[spacePath]?.hasConflicts).toBe(false);
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(spacePath);
    }
  });
}
