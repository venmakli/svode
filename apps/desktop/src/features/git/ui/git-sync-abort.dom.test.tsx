import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type {
  GitOperation,
  GitOperationStep,
  GitSequenceCommits,
} from "../model";

if (process.env.SVODE_SYNC_ABORT_DOM !== "1") {
  test("Git sync Dialog cancels a sync stopped by a merge conflict", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SYNC_ABORT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => "/project/space",
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));
  const toasts: { kind: string; message: unknown }[] = [];
  mock.module("sonner", () => ({
    toast: {
      success: (message: unknown) => toasts.push({ kind: "success", message }),
      error: (message: unknown) => toasts.push({ kind: "error", message }),
      info: (message: unknown) => toasts.push({ kind: "info", message }),
    },
  }));

  const path = "/project/space";
  let preflight: unknown = null;
  let behind = 0;
  let abort: () => Promise<unknown> = async () => ({});
  const calls: { command: string; args: unknown }[] = [];

  function mockGit() {
    mockNativeIpc(
      async (command, args) => {
        calls.push({ command, args });
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/space.git";
        if (command === "git_publication_status") return null;
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
        if (command === "git_sync_preflight") return preflight;
        if (command === "git_merge_abort" || command === "git_operation_abort")
          return abort();
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 1, behind, files: [] };
        if (command === "git_unpushed_commits") return [];
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

  async function openDialog() {
    const dom = await createTestDom();
    mockGit();
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    await dom.render(
      <TooltipProvider>
        <GitSyncStatusWidget repositoryPath={path} />
      </TooltipProvider>,
    );
    await settle();
    await act(async () => {
      dom.document
        .querySelector<HTMLButtonElement>("[data-repository-control]")!
        .click();
    });
    await settle();
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]")!;
    const buttons = (root: ParentNode) =>
      Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
    const cancelSync = () =>
      dialog().querySelector<HTMLButtonElement>("[data-git-sync-abort]");
    const confirm = () =>
      dom.document.querySelector<HTMLElement>("[role=alertdialog]");
    const close = async () => {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    };
    return { dom, m, dialog, buttons, cancelSync, confirm, close };
  }

  test("confirmed cancellation returns the Dialog to the normal view", async () => {
    preflight = { type: "conflict", files: ["Page.md"] };
    behind = 0;
    toasts.length = 0;
    calls.length = 0;
    let finish: (status: unknown) => void = () => {};
    abort = () => new Promise((resolve) => (finish = resolve));
    const ui = await openDialog();
    const { m } = ui;
    try {
      expect(
        ui
          .dialog()
          .querySelector("[data-git-sync-stop=conflict]")
          ?.textContent?.includes(m.git_sync_stop_conflict_description()),
      ).toBe(true);
      expect(
        ui
          .buttons(ui.dialog())
          .some((b) => b.textContent === m.git_sync_action()),
      ).toBe(false);
      const button = ui.cancelSync()!;
      expect(button.textContent).toBe(m.git_sync_abort_action());

      // "Back" leaves everything as it was.
      button.focus();
      await act(async () => button.click());
      await settle();
      expect(
        ui.confirm()?.textContent?.includes(m.git_sync_abort_title()),
      ).toBe(true);
      expect(
        ui.confirm()?.textContent?.includes(m.git_sync_abort_description()),
      ).toBe(true);
      await act(async () =>
        ui
          .buttons(ui.confirm()!)
          .find((b) => b.textContent === m.git_sync_abort_back())!
          .click(),
      );
      await settle();
      expect(ui.confirm()).toBe(null);
      expect(calls.some((call) => call.command === "git_merge_abort")).toBe(
        false,
      );

      await act(async () => ui.cancelSync()!.click());
      await settle();
      await act(async () =>
        ui
          .buttons(ui.confirm()!)
          .find((b) => b.textContent === m.git_sync_abort_action())!
          .click(),
      );
      await settle();
      expect(
        calls.filter((call) => call.command === "git_merge_abort"),
      ).toEqual([{ command: "git_merge_abort", args: { spacePath: path } }]);
      // In flight: the Dialog stays open and the action shows its progress.
      expect(ui.dialog() === null).toBe(false);
      expect(ui.cancelSync()?.disabled).toBe(true);
      expect(ui.cancelSync()?.getAttribute("aria-busy")).toBe("true");

      behind = 2;
      await act(async () =>
        finish({ branch: "main", ahead: 1, behind: 0, files: [] }),
      );
      await settle();
      expect(toasts).toEqual([
        { kind: "success", message: m.git_sync_abort_success() },
      ]);
      expect(ui.dialog().querySelector("[data-git-sync-stop]")).toBe(null);
      expect(ui.cancelSync()).toBe(null);
      expect(
        ui
          .buttons(ui.dialog())
          .some((b) => b.textContent === m.git_sync_action()),
      ).toBe(true);
      expect(
        ui
          .dialog()
          .textContent?.includes(m.git_sync_dialog_incoming({ count: "2" })),
      ).toBe(true);
    } finally {
      await ui.close();
    }
  });

  test("a refused cancellation keeps the conflict and can be retried", async () => {
    preflight = { type: "conflict", files: ["Page.md"] };
    toasts.length = 0;
    calls.length = 0;
    abort = async () => {
      throw "git merge --abort failed: fatal: index.lock exists";
    };
    const ui = await openDialog();
    const { m } = ui;
    try {
      await act(async () => ui.cancelSync()!.click());
      await settle();
      await act(async () =>
        ui
          .buttons(ui.confirm()!)
          .find((b) => b.textContent === m.git_sync_abort_action())!
          .click(),
      );
      await settle();
      const alerts = Array.from(
        ui.dialog().querySelectorAll<HTMLElement>("[role=alert]"),
      );
      expect(
        alerts.map((alert) => alert.dataset.gitSyncStop ?? "error"),
      ).toEqual(["error", "conflict"]);
      expect(alerts[0].textContent?.includes(m.git_sync_abort_failed())).toBe(
        true,
      );
      expect(alerts[0].textContent?.includes("index.lock exists")).toBe(true);
      expect(toasts).toEqual([]);
      expect(ui.cancelSync()?.disabled).toBe(false);
    } finally {
      await ui.close();
    }
  });

  test("conflicted files without a merge offer no cancellation", async () => {
    preflight = { type: "unmergedFiles", files: ["Page.md"] };
    const ui = await openDialog();
    try {
      expect(
        ui.dialog().querySelector("[data-git-sync-stop=unmerged]") === null,
      ).toBe(false);
      expect(ui.cancelSync()).toBe(null);
    } finally {
      await ui.close();
    }
  });

  test("an operation stop cancels the operation after a confirmation that names what is lost", async () => {
    const { gitOperationAbortCopy } = await import("./git-sync-stop-copy");
    const sequence: GitSequenceCommits = {
      head: "c0ffee",
      count: 2,
      titles: ["Resolve conflict", "Add intro"],
    };
    const stops: {
      operation: GitOperation;
      step: GitOperationStep | null;
      sequence?: GitSequenceCommits;
    }[] = [
      { operation: "rebase", step: { kind: "position", current: 1, total: 2 } },
      { operation: "cherry_pick", step: null },
      { operation: "revert", step: { kind: "remaining", count: 2 }, sequence },
      {
        operation: "sequencer",
        step: { kind: "remaining", count: 1 },
        sequence,
      },
    ];
    for (const stop of stops) {
      preflight = { type: "operationInProgress", ...stop };
      toasts.length = 0;
      calls.length = 0;
      abort = async () => ({ branch: "main", ahead: 1, behind: 0, files: [] });
      const ui = await openDialog();
      const { m } = ui;
      try {
        const copy = gitOperationAbortCopy(stop.operation, stop.step);
        expect(
          ui
            .dialog()
            .querySelector("[data-git-sync-stop=operation]")
            ?.textContent?.includes(m.git_sync_stop_operation_actions()),
        ).toBe(true);
        expect(
          Array.from(
            ui
              .dialog()
              .querySelectorAll<HTMLButtonElement>(
                "[data-slot=dialog-footer] button",
              ),
          ).map((button) => button.textContent),
        ).toEqual([m.git_operation_agent(), copy.action]);
        await act(async () => ui.cancelSync()!.click());
        await settle();
        expect(ui.confirm()?.textContent?.includes(copy.title)).toBe(true);
        expect(ui.confirm()?.textContent?.includes(copy.description)).toBe(
          true,
        );
        await act(async () =>
          ui
            .buttons(ui.confirm()!)
            .find((b) => b.textContent === m.git_sync_abort_back())!
            .click(),
        );
        await settle();
        expect(
          calls.some((call) => call.command === "git_operation_abort"),
        ).toBe(false);

        await act(async () => ui.cancelSync()!.click());
        await settle();
        await act(async () =>
          ui
            .buttons(ui.confirm()!)
            .find((b) => b.textContent === copy.action)!
            .click(),
        );
        await settle();
        expect(calls.filter((call) => call.command.endsWith("_abort"))).toEqual(
          [
            {
              command: "git_operation_abort",
              // The abort of a sequence names the HEAD its stop listed.
              args: {
                spacePath: path,
                expectedHead: stop.sequence?.head ?? null,
              },
            },
          ],
        );
        expect(toasts).toEqual([
          { kind: "success", message: m.git_operation_abort_success() },
        ]);
        expect(ui.dialog().querySelector("[data-git-sync-stop]")).toBe(null);
        expect(ui.cancelSync()).toBe(null);
      } finally {
        await ui.close();
      }
    }
  });

  test("a refused operation cancellation names its cause and can be retried", async () => {
    preflight = { type: "operationInProgress", operation: "cherry_pick" };
    toasts.length = 0;
    calls.length = 0;
    abort = async () => {
      throw {
        kind: "git_sync_failed",
        repository: "Space",
        stage: "abort",
        cause: "local_changes",
      };
    };
    const ui = await openDialog();
    const { m } = ui;
    const confirm = async () => {
      await act(async () => ui.cancelSync()!.click());
      await settle();
      await act(async () =>
        ui
          .buttons(ui.confirm()!)
          .find(
            (b) =>
              b.textContent ===
              m.git_operation_abort_action({ operation: "cherry-pick" }),
          )!
          .click(),
      );
      await settle();
    };
    try {
      await confirm();
      const alerts = Array.from(
        ui.dialog().querySelectorAll<HTMLElement>("[role=alert]"),
      );
      expect(
        alerts.map((alert) => alert.dataset.gitSyncStop ?? "error"),
      ).toEqual(["error", "operation"]);
      expect(
        alerts[0].textContent?.includes(m.git_operation_abort_failed()),
      ).toBe(true);
      expect(alerts[0].textContent?.includes(m.git_sync_stage_abort())).toBe(
        true,
      );
      expect(
        alerts[0].textContent?.includes(m.git_failure_cause_local_changes()),
      ).toBe(true);
      expect(toasts).toEqual([]);
      expect(ui.cancelSync()?.disabled).toBe(false);

      // The retry after the person sets the edits aside succeeds.
      abort = async () => ({ branch: "main", ahead: 1, behind: 0, files: [] });
      await confirm();
      expect(ui.dialog().querySelector("[data-git-sync-abort-error]")).toBe(
        null,
      );
      expect(ui.dialog().querySelector("[data-git-sync-stop]")).toBe(null);
      expect(toasts).toEqual([
        { kind: "success", message: m.git_operation_abort_success() },
      ]);
    } finally {
      await ui.close();
    }
  });
}
