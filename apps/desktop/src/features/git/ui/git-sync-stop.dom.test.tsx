import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import type { SyncResultDto } from "@/platform/git/git-types";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_SYNC_STOP_DOM !== "1") {
  test("Git sync Dialog shows an unfinished Git operation in its slot", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SYNC_STOP_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => "/project/space",
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));

  const path = "/project/space";
  const longPage = `${"Очень длинное название страницы ".repeat(6)}.md`;
  let preflight: unknown = null;
  let syncReport: unknown = null;
  let syncFailure: unknown = null;
  const commands: string[] = [];
  const syncArgs: unknown[] = [];

  function mockGit() {
    mockNativeIpc(
      async (command, args) => {
        commands.push(command);
        if (command === "git_sync") syncArgs.push(args);
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
        if (command === "git_sync") {
          if (syncFailure) throw syncFailure;
          return syncReport;
        }
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 1, behind: 2, files: [] };
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

  test("merge in progress replaces the error slot and hides Sync", async () => {
    const dom = await createTestDom();
    mockGit();
    preflight = {
      type: "conflict",
      files: [longPage, "order.json", "Removed.md"],
    };
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const m = await import("@/paraglide/messages.js");
    const previousLocale = getLocale();
    const opened: unknown[] = [];
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        // A stale sync error must not compete with the stop for focus.
        useGitStore.getState().setSyncError(path, "git pull failed");
        await dom.render(
          <TooltipProvider>
            <GitSyncStatusWidget
              key={locale}
              repositoryPath={path}
              onOpenPage={(target) => opened.push(target)}
            />
          </TooltipProvider>,
        );
        await settle();
        const control = dom.document.querySelector<HTMLButtonElement>(
          "[data-repository-control]",
        )!;
        expect(
          control
            .getAttribute("aria-label")
            ?.includes(m.git_sync_stop_conflict_title()),
        ).toBe(true);
        await act(async () => {
          control.click();
        });
        await settle();
        const dialog =
          dom.document.querySelector<HTMLElement>("[role=dialog]")!;
        const slot = dialog.querySelector<HTMLElement>(
          "[data-git-sync-stop=conflict]",
        )!;
        expect(!!slot).toBe(true);
        expect(slot.className.includes("text-destructive")).toBe(false);
        expect(dialog.querySelectorAll("[role=alert]").length).toBe(1);
        expect(
          slot.textContent?.includes(m.git_sync_stop_conflict_title()),
        ).toBe(true);
        expect(
          slot.textContent?.includes(m.git_sync_stop_conflict_description()),
        ).toBe(true);
        const list = slot.querySelector<HTMLElement>("ul")!;
        expect(list.getAttribute("aria-label")).toBe(
          m.git_sync_stop_conflict_files(),
        );
        expect(list.className?.includes("max-h-40")).toBe(true);
        expect(list.className?.includes("overflow-y-auto")).toBe(true);
        const rows = Array.from(list.querySelectorAll("li"));
        expect(rows.length).toBe(3);
        const pageLink = rows[0].querySelector("button")!;
        expect(pageLink.title).toBe(longPage);
        expect(pageLink.querySelector(".truncate")?.textContent).toBe(longPage);
        expect(rows[1].querySelector("button")).toBe(null);
        expect(
          rows[1].textContent?.includes(m.git_sync_stop_resolved_in_git()),
        ).toBe(true);
        expect(rows[2].querySelector("button") === null).toBe(false);
        // Counters stay below the slot; Sync is hidden in the footer.
        expect(
          dialog.textContent?.includes(
            m.git_sync_incoming_summary({ count: "2" }),
          ),
        ).toBe(true);
        expect(
          Array.from(dialog.querySelectorAll("button")).some(
            (button) => button.textContent === m.git_sync_action(),
          ),
        ).toBe(false);

        pageLink.focus();
        expect(dom.document.activeElement).toBe(pageLink);
        await act(async () => {
          pageLink.click();
        });
        await settle();
        expect(opened.at(-1)).toEqual({
          spacePath: path,
          repositoryPath: path,
          path: longPage,
        });
        expect(dom.document.querySelector("[role=dialog]")).toBe(null);
        await dom.render(null);
      }
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
      await setLocale(previousLocale, { reload: false });
    }
  });

  test("another operation is named with no Svode action", async () => {
    const dom = await createTestDom();
    mockGit();
    preflight = { type: "operationInProgress", operation: "cherry_pick" };
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    try {
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} onOpenPage={() => {}} />
        </TooltipProvider>,
      );
      await settle();
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>("[role=dialog]")!;
      const slot = dialog.querySelector<HTMLElement>(
        "[data-git-sync-stop=operation]",
      )!;
      expect(
        slot.textContent?.includes(
          m.git_sync_stop_operation_title({ operation: "cherry-pick" }),
        ),
      ).toBe(true);
      expect(
        slot.textContent?.includes(m.git_sync_stop_operation_description()),
      ).toBe(true);
      expect(slot.querySelector("button, ul")).toBe(null);
      expect(
        Array.from(dialog.querySelectorAll("button")).some(
          (button) => button.textContent === m.git_sync_action(),
        ),
      ).toBe(false);
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });

  test("conflicted files without an operation show where the local version went, with no cancel", async () => {
    const dom = await createTestDom();
    mockGit();
    preflight = { type: "unmergedFiles", files: ["q.md", "order.json"] };
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { syncSpace } = await import("../api/git-actions");
    const m = await import("@/paraglide/messages.js");
    try {
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} onOpenPage={() => {}} />
        </TooltipProvider>,
      );
      await settle();
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>("[role=dialog]")!;
      const slot = dialog.querySelector<HTMLElement>(
        "[data-git-sync-stop=unmerged]",
      )!;
      expect(
        slot.textContent?.includes(m.git_sync_stop_unmerged_description()),
      ).toBe(true);
      expect(
        slot.textContent?.includes(m.git_sync_stop_conflict_description()),
      ).toBe(false);
      const rows = Array.from(slot.querySelectorAll("li"));
      expect(rows.map((row) => row.textContent)).toEqual([
        "q.md",
        `order.json${m.git_sync_stop_resolved_in_git()}`,
      ]);
      expect(rows[0].querySelector("button")?.title).toBe("q.md");
      // Neither Sync nor any other action: the stash is left to the user.
      const buttons = Array.from(dialog.querySelectorAll("button")).map(
        (button) => button.textContent,
      );
      expect(buttons.includes(m.git_sync_action())).toBe(false);
      expect(
        Array.from(dialog.querySelectorAll("button[data-variant=destructive]"))
          .length,
      ).toBe(0);

      syncReport = { type: "unmergedFiles", files: ["q.md"] };
      expect(await syncSpace(path)).toEqual({
        type: "UnmergedFiles",
        files: ["q.md"],
      });
      expect(useGitStore.getState().syncStop[path]).toEqual({
        kind: "unmerged",
        files: ["q.md"],
      });
      expect(path in useGitStore.getState().syncError).toBe(false);
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });

  test("sync attempts and background outcomes set and clear the stop", async () => {
    const dom = await createTestDom();
    mockGit();
    const { useGitStore } = await import("../model/git-store");
    const { syncSpace } = await import("../api/git-actions");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    try {
      syncReport = { type: "operationInProgress", operation: "rebase" };
      expect(await syncSpace(path)).toEqual({
        type: "OperationInProgress",
        operation: "rebase",
      });
      expect(useGitStore.getState().syncStop[path]).toEqual({
        kind: "operation",
        operation: "rebase",
      });
      expect(path in useGitStore.getState().syncError).toBe(false);

      recordGitOperationOutcome({
        repository: path,
        active: false,
        report: { type: "conflict", files: ["Page.md"] },
        error: null,
      });
      expect(useGitStore.getState().syncStop[path]).toEqual({
        kind: "conflict",
        files: ["Page.md"],
        service: [],
      });
      expect(path in useGitStore.getState().syncError).toBe(false);

      // A background sync skipped by policy says nothing about the operation.
      recordGitOperationOutcome({
        repository: path,
        active: false,
        report: { type: "noRemote" },
        error: null,
      });
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("conflict");

      syncReport = { type: "success", publishedHead: "abc" };
      expect((await syncSpace(path)).type).toBe("Success");
      expect(path in useGitStore.getState().syncStop).toBe(false);
    } finally {
      useGitStore.getState().clear(path);
      clearNativeMocks();
      await dom.dispose();
    }
  });

  test("the publication guard stops only publication and names the file and commit", async () => {
    const dom = await createTestDom();
    mockGit();
    preflight = null;
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const guard = {
      kind: "git_publication_blocked",
      repository: path,
      reason: "content",
      path: "Задачи/schema.yaml",
      commit,
      finding: "conflict_markers",
    };
    const stop = {
      kind: "publication",
      path: "Задачи/schema.yaml",
      commit,
      finding: "conflict_markers",
    };
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { syncSpace } = await import("../api/git-actions");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    const m = await import("@/paraglide/messages.js");
    try {
      syncFailure = guard;
      expect(await syncSpace(path)).toEqual({
        type: "Failed",
        message: m.git_publication_content_blocked({
          reason: m.git_sync_stop_publication_markers(),
          path: "Задачи/schema.yaml",
          commit: "0123456",
        }),
        block: undefined,
        stop,
      });
      expect(useGitStore.getState().syncStop[path]).toEqual(stop);
      expect(path in useGitStore.getState().syncError).toBe(false);

      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} onOpenPage={() => {}} />
        </TooltipProvider>,
      );
      await settle();
      const control = dom.document.querySelector<HTMLButtonElement>(
        "[data-repository-control]",
      )!;
      // The preflight read on mount finds nothing and keeps the stop.
      expect(useGitStore.getState().syncStop[path]).toEqual(stop);
      expect(
        control
          .getAttribute("aria-label")
          ?.includes(m.git_sync_stop_publication_title()),
      ).toBe(true);
      expect(
        !!control.querySelector("[data-git-sync-stopped]") &&
          !control.querySelector("[data-git-sync-error]"),
      ).toBe(true);
      await act(async () => {
        control.click();
      });
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>("[role=dialog]")!;
      const slot = dialog.querySelector<HTMLElement>(
        "[data-git-sync-stop=publication]",
      )!;
      expect(dialog.querySelectorAll("[role=alert]").length).toBe(1);
      for (const text of [
        m.git_sync_stop_publication_title(),
        m.git_sync_stop_publication_markers(),
        m.git_sync_stop_publication_hint(),
      ])
        expect(slot.textContent?.includes(text)).toBe(true);
      const file = slot.querySelector<HTMLElement>(
        "[data-publication-stop-path]",
      )!;
      expect(file.textContent).toBe("Задачи/schema.yaml");
      expect(file.title).toBe("Задачи/schema.yaml");
      const shown = slot.querySelector<HTMLElement>(
        "[data-publication-stop-commit]",
      )!;
      expect(shown.textContent).toBe("0123456");
      expect(shown.title).toBe(commit);
      // No action of its own; Sync publishes once the file is fixed.
      expect(slot.querySelector("button")).toBe(null);
      expect(
        Array.from(dialog.querySelectorAll("button")).some(
          (button) => button.textContent === m.git_sync_action(),
        ),
      ).toBe(true);

      // Any other failure ends the stop and is an error again.
      syncFailure = "network down";
      expect((await syncSpace(path)).type).toBe("Failed");
      expect(path in useGitStore.getState().syncStop).toBe(false);
      expect(useGitStore.getState().syncError[path]).toBe("network down");

      // A background sync refused by the guard, then a published one.
      recordGitOperationOutcome({
        repository: path,
        active: false,
        report: null,
        error: { ...guard, finding: "unreadable" },
      });
      expect(useGitStore.getState().syncStop[path]).toEqual({
        ...stop,
        finding: "unreadable",
      });
      expect(path in useGitStore.getState().syncError).toBe(false);
      recordGitOperationOutcome({
        repository: path,
        active: false,
        report: { type: "success", publishedHead: commit },
        error: null,
      });
      expect(path in useGitStore.getState().syncStop).toBe(false);
    } finally {
      syncFailure = null;
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });
  test("a refused automatic commit stops with its cause until the next version", async () => {
    const dom = await createTestDom();
    mockGit();
    preflight = null;
    const refusal = {
      kind: "git_save_failed",
      repository: "Исследования",
      stage: "commit",
      cause: "hook",
      reason: "command_failed",
      exitCode: 1,
      pathCount: 1,
      pathSample: "Page.md",
    };
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { syncSpace } = await import("../api/git-actions");
    const { recordAutoVersionOutcome } =
      await import("../api/git-auto-version-actions");
    const m = await import("@/paraglide/messages.js");
    try {
      recordAutoVersionOutcome({ repository: path, error: refusal });
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("commit");

      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} onOpenPage={() => {}} />
        </TooltipProvider>,
      );
      await settle();
      const control = dom.document.querySelector<HTMLButtonElement>(
        "[data-repository-control]",
      )!;
      // The preflight read on mount finds nothing and keeps the stop.
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("commit");
      expect(
        control
          .getAttribute("aria-label")
          ?.includes(m.git_sync_stop_commit_title()),
      ).toBe(true);
      expect(!!control.querySelector("[data-git-sync-stopped]")).toBe(true);
      await act(async () => {
        control.click();
      });
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>("[role=dialog]")!;
      const slot = dialog.querySelector<HTMLElement>(
        "[data-git-sync-stop=commit]",
      )!;
      for (const text of [
        m.git_sync_stop_commit_title(),
        m.git_failure_cause_hook(),
        m.git_sync_stop_commit_hint(),
      ])
        expect(slot.textContent?.includes(text)).toBe(true);
      expect(slot.querySelector("button")).toBe(null);
      // Sync still runs and does not end the stop: only the next automatic
      // version does.
      expect(
        Array.from(dialog.querySelectorAll("button")).some(
          (button) => button.textContent === m.git_sync_action(),
        ),
      ).toBe(true);
      syncReport = { type: "success", publishedHead: "abc" };
      expect((await syncSpace(path)).type).toBe("Success");
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("commit");

      recordAutoVersionOutcome({ repository: path, error: null });
      expect(path in useGitStore.getState().syncStop).toBe(false);
      // An outcome without a stop leaves other stops alone.
      useGitStore.getState().setSyncStop(path, {
        kind: "conflict",
        files: ["Page.md"],
        service: [],
      });
      recordAutoVersionOutcome({ repository: path, error: null });
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("conflict");
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });

  test("a background conflict stops with its files and kinds until the next preflight", async () => {
    const dom = await createTestDom();
    mockGit();
    preflight = null;
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    const m = await import("@/paraglide/messages.js");
    const incoming = {
      repository: path,
      active: false,
      report: {
        type: "incomingConflict",
        files: [
          { path: "Page.md", kind: "page_properties" },
          { path: "space", kind: "space_pointer" },
        ],
        service: [{ path: "space", state: "space_diverged" }],
      } satisfies SyncResultDto,
      error: null,
    };
    try {
      recordGitOperationOutcome(incoming);
      expect(useGitStore.getState().syncStop[path]).toEqual({
        kind: "incoming",
        files: [
          { path: "Page.md", kind: "page_properties" },
          { path: "space", kind: "space_pointer" },
        ],
        service: [{ path: "space", state: "space_diverged" }],
      });

      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} onOpenPage={() => {}} />
        </TooltipProvider>,
      );
      await settle();
      const control = dom.document.querySelector<HTMLButtonElement>(
        "[data-repository-control]",
      )!;
      // The preflight read of the repository on mount does not end it.
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("incoming");
      expect(
        control
          .getAttribute("aria-label")
          ?.includes(m.git_sync_stop_incoming_title()),
      ).toBe(true);
      // The existing «sync stopped» state, not an error.
      expect(!!control.querySelector("[data-git-sync-stopped]")).toBe(true);
      expect(control.querySelector("[data-git-sync-error]")).toBe(null);
      await act(async () => {
        control.click();
      });
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>("[role=dialog]")!;
      const slot = dialog.querySelector<HTMLElement>(
        "[data-git-sync-stop=incoming]",
      )!;
      expect(slot.textContent?.includes(m.git_sync_stop_incoming_title())).toBe(
        true,
      );
      expect(
        slot.textContent?.includes(m.git_sync_stop_incoming_description()),
      ).toBe(true);
      const rows = Array.from(
        slot.querySelectorAll<HTMLElement>("[data-git-incoming-conflict]"),
      );
      expect(rows.map((row) => row.dataset.gitIncomingConflict)).toEqual([
        "page_properties",
        "space_pointer",
      ]);
      expect(rows[0].textContent).toBe(
        `Page.md${m.git_conflict_kind_page_properties()}`,
      );
      expect(rows[1].textContent).toBe(
        `space${m.git_conflict_kind_space_pointer()} · ${m.git_sync_service_space_diverged()}`,
      );
      expect(slot.querySelector("button")).toBe(null);
      const buttons = Array.from(dialog.querySelectorAll("button"));
      expect(
        buttons.some(
          (button) => button.textContent === m.git_sync_abort_action(),
        ),
      ).toBe(false);
      const resolve = buttons.find(
        (button) => button.textContent === m.git_sync_stop_incoming_action(),
      )!;
      expect(!!resolve).toBe(true);

      // «Синхронизировать и разрешить» runs an explicit sync, which enters
      // the merge state.
      syncArgs.length = 0;
      syncReport = { type: "conflict", files: ["Page.md"] };
      await act(async () => {
        resolve.click();
      });
      await settle();
      expect(syncArgs.length).toBe(1);
      expect((syncArgs[0] as { background?: boolean }).background).toBe(false);
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("conflict");

      // The next background preflight without a conflict ends the stop.
      await act(async () => {
        useGitStore.getState().setSyncStop(path, null);
        recordGitOperationOutcome(incoming);
      });
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("incoming");
      await act(async () => {
        recordGitOperationOutcome({
          repository: path,
          active: false,
          report: { type: "success", publishedHead: "abc" },
          error: null,
        });
      });
      expect(path in useGitStore.getState().syncStop).toBe(false);

      // On a Git without merges in memory, diverged commits wait for Sync.
      await act(async () => {
        recordGitOperationOutcome({
          repository: path,
          active: false,
          report: { type: "explicitSyncRequired" },
          error: null,
        });
      });
      await settle();
      const explicit = dialog.querySelector<HTMLElement>(
        "[data-git-sync-stop=explicit_sync]",
      )!;
      expect(
        explicit.textContent?.includes(m.git_sync_stop_explicit_title()),
      ).toBe(true);
      expect(
        explicit.textContent?.includes(m.git_sync_stop_explicit_description()),
      ).toBe(true);
      expect(
        Array.from(dialog.querySelectorAll("button")).some(
          (button) => button.textContent === m.git_sync_action(),
        ),
      ).toBe(true);
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });
}
