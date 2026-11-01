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
        const copy = gitOperationAbortCopy(
          stop.operation,
          stop.step,
          stop.sequence,
        );
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
        // A sequence lists the commits it drops under the text.
        expect(
          Array.from(
            ui
              .confirm()!
              .querySelectorAll("[data-git-operation-abort-commits] li"),
          ).map((item) => item.textContent),
        ).toEqual(stop.sequence?.titles ?? []);
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

  type OperationUi = Awaited<ReturnType<typeof openDialog>>;

  async function openConfirmation(ui: OperationUi) {
    await act(async () => ui.cancelSync()!.click());
    await settle();
  }

  async function confirmAbort(ui: OperationUi) {
    await act(async () =>
      ui
        .buttons(ui.confirm()!)
        .find((b) => b.textContent === ui.cancelSync()!.textContent)!
        .click(),
    );
    await settle();
  }

  const listed = (ui: OperationUi) =>
    Array.from(
      ui.confirm()!.querySelectorAll("[data-git-operation-abort-commits] li"),
    ).map((item) => item.textContent);

  const operationAborts = () =>
    calls.filter((call) => call.command === "git_operation_abort");

  test("a sequence confirmation lists the newest commits it drops and counts the rest, in en and ru", async () => {
    const { setLocale } = await import("@/paraglide/runtime");
    const titles = ["Resolve conflict", "Add intro", "Fix typo", "Edit", "Add"];
    const expected = {
      en: { summary: "Commits that will be lost: 12", more: "and 7 more" },
      ru: { summary: "Пропадут коммиты: 12", more: "и ещё 7" },
    };
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        preflight = {
          type: "operationInProgress",
          operation: "cherry_pick",
          step: { kind: "remaining", count: 1 },
          sequence: { head: "c0ffee", count: 12, titles },
        };
        calls.length = 0;
        const ui = await openDialog();
        const { m } = ui;
        try {
          await openConfirmation(ui);
          const confirm = ui.confirm()!;
          expect(
            confirm.textContent?.includes(
              m.git_operation_abort_sequence_description(),
            ),
          ).toBe(true);
          const commits = confirm.querySelector<HTMLElement>(
            "[data-git-operation-abort-commits]",
          )!;
          expect(
            commits.textContent?.startsWith(expected[locale].summary),
          ).toBe(true);
          expect(listed(ui)).toEqual([...titles, expected[locale].more]);
          // The list belongs to the confirmation's description.
          expect(
            confirm
              .querySelector("[data-slot=alert-dialog-description]")
              ?.contains(commits),
          ).toBe(true);
        } finally {
          await ui.close();
        }
      }
    } finally {
      await setLocale("en", { reload: false });
    }
  });

  test("a sequence refusal names its cause without Git terms and keeps retry and the agent", async () => {
    const causes = [
      "branch_left_sequence",
      "commits_published",
      "state_changed",
    ] as const;
    for (const cause of causes) {
      preflight = {
        type: "operationInProgress",
        operation: "revert",
        step: { kind: "remaining", count: 1 },
        sequence: { head: "c0ffee", count: 1, titles: ["Add intro"] },
      };
      toasts.length = 0;
      calls.length = 0;
      abort = async () => {
        throw {
          kind: "git_sync_failed",
          repository: "Space",
          stage: "abort",
          cause,
        };
      };
      const ui = await openDialog();
      const { m } = ui;
      const message = {
        branch_left_sequence: m.git_failure_cause_branch_left_sequence,
        commits_published: m.git_failure_cause_commits_published,
        state_changed: m.git_failure_cause_state_changed,
      }[cause]();
      try {
        await openConfirmation(ui);
        await confirmAbort(ui);
        const error = ui
          .dialog()
          .querySelector<HTMLElement>("[data-git-sync-abort-error]")!;
        expect(
          error.textContent?.includes(m.git_operation_abort_failed()),
        ).toBe(true);
        expect(error.textContent?.includes(message)).toBe(true);
        expect(/HEAD|terminal|remote-tracking/.test(message)).toBe(false);
        expect(
          ui.dialog().querySelector("[data-git-sync-stop=operation]") === null,
        ).toBe(false);
        expect(toasts).toEqual([]);
        expect(ui.cancelSync()?.disabled).toBe(false);
        expect(
          ui
            .buttons(ui.dialog())
            .some((b) => b.textContent === m.git_operation_agent()),
        ).toBe(true);
        // The retry asks again.
        await openConfirmation(ui);
        expect(ui.confirm() === null).toBe(false);
      } finally {
        await ui.close();
      }
    }
  });

  test("after a changed state the Dialog reads the stop again and the retry lists and names the new commits", async () => {
    const first = { head: "aaa", count: 1, titles: ["Add intro"] };
    const next = {
      head: "bbb",
      count: 2,
      titles: ["Resolve conflict", "Add intro"],
    };
    const stopWith = (sequence: GitSequenceCommits) => ({
      type: "operationInProgress",
      operation: "cherry_pick",
      step: { kind: "remaining", count: 1 },
      sequence,
    });
    preflight = stopWith(first);
    toasts.length = 0;
    calls.length = 0;
    abort = async () => {
      // A commit made meanwhile: the stop now lists another HEAD.
      preflight = stopWith(next);
      throw {
        kind: "git_sync_failed",
        repository: "Space",
        stage: "abort",
        cause: "state_changed",
      };
    };
    const ui = await openDialog();
    const { m } = ui;
    try {
      await openConfirmation(ui);
      expect(listed(ui)).toEqual(first.titles);
      const reads = calls.filter(
        (c) => c.command === "git_sync_preflight",
      ).length;
      await confirmAbort(ui);
      expect(operationAborts().map((call) => call.args)).toEqual([
        { spacePath: path, expectedHead: "aaa" },
      ]);
      expect(
        calls.filter((c) => c.command === "git_sync_preflight").length > reads,
      ).toBe(true);
      expect(
        ui
          .dialog()
          .querySelector("[data-git-sync-abort-error]")
          ?.textContent?.includes(m.git_failure_cause_state_changed()),
      ).toBe(true);

      abort = async () => ({ branch: "main", ahead: 1, behind: 0, files: [] });
      await openConfirmation(ui);
      expect(
        ui
          .confirm()
          ?.textContent?.includes(
            m.git_operation_abort_sequence_commits({ count: "2" }),
          ),
      ).toBe(true);
      expect(listed(ui)).toEqual(next.titles);
      await confirmAbort(ui);
      expect(operationAborts().map((call) => call.args)).toEqual([
        { spacePath: path, expectedHead: "aaa" },
        { spacePath: path, expectedHead: "bbb" },
      ]);
      expect(toasts).toEqual([
        { kind: "success", message: m.git_operation_abort_success() },
      ]);
    } finally {
      await ui.close();
    }
  });

  test("an open confirmation keeps the list it showed and the cancellation names its HEAD", async () => {
    const shown = { head: "aaa", count: 1, titles: ["Add intro"] };
    const stopWith = (sequence: GitSequenceCommits) => ({
      type: "operationInProgress",
      operation: "sequencer",
      step: { kind: "remaining", count: 1 },
      sequence,
    });
    preflight = stopWith(shown);
    toasts.length = 0;
    calls.length = 0;
    abort = async () => ({ branch: "main", ahead: 1, behind: 0, files: [] });
    const ui = await openDialog();
    try {
      await openConfirmation(ui);
      // The stop is read again while the person reads the confirmation.
      preflight = stopWith({
        head: "bbb",
        count: 2,
        titles: ["Fix", "Add intro"],
      });
      const { refreshGitSyncStop } =
        await import("../api/git-sync-stop-actions");
      await act(async () => {
        await refreshGitSyncStop(path);
      });
      await settle();
      expect(listed(ui)).toEqual(shown.titles);
      await confirmAbort(ui);
      expect(operationAborts().map((call) => call.args)).toEqual([
        { spacePath: path, expectedHead: "aaa" },
      ]);
    } finally {
      await ui.close();
    }
  });
}
