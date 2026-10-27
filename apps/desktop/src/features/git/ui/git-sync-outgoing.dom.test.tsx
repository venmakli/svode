import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_SYNC_OUTGOING_DOM !== "1") {
  test("Git sync Dialog keeps the outgoing commit list in step with its counters", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SYNC_OUTGOING_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  // A Space other than the active one refreshes itself on window focus.
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => "/project",
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));
  mock.module("sonner", () => ({
    toast: {
      success: () => {},
      error: () => {},
      info: () => {},
      warning: () => {},
    },
  }));

  test("every counter update of the open Dialog rereads the list, and only the latest list shows", async () => {
    const path = "/project/space";
    const parent = {
      repository: "/project",
      pointer: "local",
      target: "original",
      policySkipped: true,
    };
    let ahead = 1;
    let listFails = false;
    let holdList = false;
    const held: (() => void)[] = [];
    const calls: string[] = [];
    const status = (count: number) => ({
      branch: "main",
      ahead: count,
      behind: 0,
      files: [],
      hasStaged: false,
      hasUnstaged: false,
      hasConflicts: false,
      tracking: "origin/main",
    });
    const commits = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        sha: `sha${count}-${index}`,
        message: `Commit ${index + 1} of ${count}`,
        author: "Fixture",
        timestamp: "0",
      }));
    const dom = await createTestDom();
    mockNativeIpc(
      async (command) => {
        calls.push(command);
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/space.git";
        if (command === "git_publication_status") return null;
        if (command === "git_sync_preflight") return null;
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: path,
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_fetch_status" || command === "git_status")
          return status(ahead);
        if (command === "git_merge_abort") return status(ahead);
        if (command === "git_sync")
          return {
            type: "success",
            publishedHead: "sha",
            remoteStatus: status(ahead),
            parent,
          };
        if (command === "git_unpushed_commits") {
          if (listFails) throw "git log failed";
          const list = commits(ahead);
          if (holdList)
            return new Promise((resolve) => held.push(() => resolve(list)));
          return list;
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { refreshGitRemoteStatus } =
      await import("../api/git-status-actions");
    const { abortGitSyncMerge } = await import("../api/git-sync-stop-actions");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]");
    const shown = () =>
      Array.from(dialog()?.querySelectorAll("section li") ?? []).map(
        (row) => row.querySelector(".font-mono")?.textContent,
      );
    const counter = (count: number) =>
      dialog()?.textContent?.includes(
        m.git_sync_outgoing_summary({ count: String(count) }),
      );
    const text = () => dialog()?.textContent ?? "";
    const reads = () =>
      calls.filter((call) => call === "git_unpushed_commits").length;
    const expectList = (count: number) => {
      expect(counter(count)).toBe(true);
      expect(shown()).toEqual(commits(count).map((commit) => commit.sha));
      expect(text().includes(m.git_sync_outgoing_empty())).toBe(false);
    };
    try {
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} />
        </TooltipProvider>,
      );
      await settle();

      // A closed Dialog does not read the list when its counters change.
      ahead = 2;
      await act(async () => {
        await refreshGitRemoteStatus(path);
      });
      await settle();
      expect(reads()).toBe(0);
      expect(
        dom.document
          .querySelector("[data-repository-control]")
          ?.textContent?.includes("2↑"),
      ).toBe(true);

      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await settle();
      expectList(2);

      // Cancelling a stopped sync rereads the counters, and the list follows.
      ahead = 3;
      await act(async () => {
        await abortGitSyncMerge(path);
      });
      await settle();
      expectList(3);

      // So does the refresh on window focus.
      ahead = 4;
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
      await settle();
      expectList(4);

      // A background sync carries its remote status; the list rereads only
      // local history, without a fetch.
      ahead = 5;
      const fetches = calls.filter((call) => call === "git_fetch_status");
      await act(async () => {
        recordGitOperationOutcome({
          repository: path,
          active: false,
          report: {
            type: "success",
            publishedHead: "sha",
            remoteStatus: status(5),
          },
          error: null,
        });
      });
      await settle();
      expectList(5);
      expect(calls.filter((call) => call === "git_fetch_status")).toEqual(
        fetches,
      );

      // A partial sync keeps the Dialog open with the new counters.
      ahead = 6;
      const sync = Array.from(
        dialog()!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === m.git_sync_action())!;
      await act(async () => sync.click());
      await settle();
      expect(dialog() === null).toBe(false);
      expectList(6);

      // A list read for older counters never replaces the newer one.
      holdList = true;
      ahead = 7;
      await act(async () => {
        await refreshGitRemoteStatus(path);
      });
      await settle();
      expect(held.length).toBe(1);
      // While the list of the new counters is read, the previous one stays.
      expect(shown()).toEqual(commits(6).map((commit) => commit.sha));
      ahead = 8;
      await act(async () => {
        await refreshGitRemoteStatus(path);
      });
      await settle();
      await act(async () => held[1]());
      await settle();
      expectList(8);
      await act(async () => held[0]());
      await settle();
      expectList(8);
      holdList = false;
      held.length = 0;

      // A failed read is not an empty list, and the next update reads again.
      listFails = true;
      ahead = 9;
      await act(async () => {
        await refreshGitRemoteStatus(path);
      });
      await settle();
      expect(counter(9)).toBe(true);
      expect(shown()).toEqual([]);
      expect(text().includes(m.git_sync_outgoing_empty())).toBe(false);
      expect(
        dialog()?.querySelector("[data-git-outgoing-failed]")?.textContent,
      ).toBe(m.git_sync_outgoing_load_failed());

      listFails = false;
      holdList = true;
      await act(async () => {
        await refreshGitRemoteStatus(path);
      });
      await settle();
      expect(text().includes(m.git_unpushed_loading())).toBe(true);
      expect(text().includes(m.git_sync_outgoing_empty())).toBe(false);
      expect(dialog()?.querySelector("[data-git-outgoing-failed]")).toBe(null);
      await act(async () => held[0]());
      await settle();
      expectList(9);
      holdList = false;

      // Closed again, counter updates do not read the list.
      await act(async () => {
        dom.document.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      await settle();
      expect(dialog()).toBe(null);
      const before = reads();
      ahead = 10;
      await act(async () => {
        await refreshGitRemoteStatus(path);
      });
      await settle();
      expect(reads()).toBe(before);
    } finally {
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear(path);
      useGitStore.getState().clear("/project");
      await dom.dispose();
    }
  });
}
