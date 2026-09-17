import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { GitSyncWidget } from "./use-git-sync-widget";

if (process.env.SVODE_GIT_LIFECYCLE_DOM !== "1") {
  test("Git widget keeps async results within their Space session and recovery stage", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_GIT_LIFECYCLE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  test("switch away and back ignores late config/auth; partial retry only updates parent", async () => {
    const dom = await createTestDom();
    let path = "/project/child";
    const state = { activeRootPath: "/project" };
    mock.module("@/features/space", () => ({
      selectActiveSpacePath: () => path,
      useSpace: (select: (value: typeof state) => unknown) => select(state),
    }));
    const calls: string[] = [];
    const status = {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [],
      hasStaged: false,
      hasUnstaged: false,
      hasConflicts: false,
      tracking: "origin/main",
    };
    let configReply: ((value: unknown) => void) | undefined;
    let syncReply: ((value: unknown) => void) | undefined;
    let configCount = 0;
    let syncResult: unknown = null;
    const parent = {
      repository: "/project",
      pointer: "local",
      target: "original",
      policySkipped: true,
    };
    mockNativeIpc(
      async (command) => {
        calls.push(command);
        if (command === "git_get_user_policy") {
          if (++configCount === 1)
            return new Promise((resolve) => {
              configReply = resolve;
            });
          return { autoSync: false };
        }
        if (command === "git_get_remote")
          return "https://example.test/repo.git";
        if (command === "git_publication_status") return null;
        if (command === "git_fetch_status" || command === "git_status")
          return status;
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync") {
          if (syncResult) return syncResult;
          return new Promise((resolve) => {
            syncReply = resolve;
          });
        }
        if (command === "git_retry_parent")
          return {
            childHead: "sha",
            child: "published",
            parent: { ...parent, pointer: "published" },
          };
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitSyncWidget } = await import("./use-git-sync-widget");
    const { useGitStore } = await import("../model/git-store");
    let widget!: GitSyncWidget;
    function Probe({ revision }: { revision: number }) {
      const current = useGitSyncWidget();
      useEffect(() => {
        widget = current;
      });
      return <div data-revision={revision}>{current.branch}</div>;
    }
    let revision = 0;
    const render = async (next: string) => {
      path = next;
      await dom.render(<Probe revision={revision++} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    try {
      await render("/project/child");
      let pending!: Promise<void>;
      await act(async () => {
        pending = widget.syncNow();
      });
      await render("/other");
      await render("/project/child");
      await act(async () => {
        configReply!({ autoSync: true });
        syncReply!({
          type: "authRequired",
          challenge: {
            operation: "sync",
            authMethod: "https",
            remoteUrl: "https://example.test/repo.git",
            host: "example.test",
            repository: "repo",
            providerHint: null,
            detail: null,
          },
        });
        await pending;
      });
      expect(widget.authOpen).toBe(false);
      expect(widget.autoSync).toBe(false);
      expect(widget.open).toBe(false);

      syncResult = {
        type: "success",
        publishedHead: "sha",
        remoteStatus: status,
        parent,
      };
      await act(async () => {
        widget.setOpen(true);
      });
      calls.length = 0;
      await act(async () => {
        await widget.syncNow();
      });
      expect(widget.open).toBe(true);
      expect(widget.parent.publication?.parent.pointer).toBe("local");
      expect(widget.parent.action).toBe("retry");
      expect(widget.remoteChecked).toBe(true);
      expect(calls).toEqual(["git_sync"]);
      calls.length = 0;
      await act(async () => {
        await widget.parent.run();
      });
      expect(calls).toEqual(["git_retry_parent"]);
      expect(widget.parent.publication?.parent.pointer).toBe("published");

      syncResult = {
        type: "success",
        publishedHead: "sha",
        remoteStatus: status,
      };
      calls.length = 0;
      await act(async () => {
        await widget.syncNow();
      });
      expect(widget.open).toBe(false);
      expect(calls).toEqual(["git_sync"]);
    } finally {
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear("/project/child");
      useGitStore.getState().clear("/other");
      await dom.dispose();
    }
  });
}
