import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
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
  });
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
  const commands: string[] = [];

  function mockGit() {
    mockNativeIpc(
      async (command) => {
        commands.push(command);
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
        if (command === "git_sync") return syncReport;
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
}
