import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_SERVICE_MERGE_DOM !== "1") {
  test("Git sync Dialog names merged Svode service files and offers their actions", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SERVICE_MERGE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => "/project",
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));

  const path = "/project";
  const ORDER = ".svode/order.json";
  let preflight: unknown = null;
  const results: Record<string, unknown[]> = {};
  const calls: { command: string; args: Record<string, unknown> }[] = [];

  function mockGit() {
    mockNativeIpc(
      async (command, args) => {
        calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
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
        if (command === "git_sync" || command === "git_merge_service_files") {
          const next = results[command]?.shift();
          if (!next) throw new Error(`unexpected ${command}`);
          return next;
        }
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 0, behind: 0, files: [] };
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
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]")!;
    const close = async () => {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    };
    return { dom, dialog, close, useGitStore };
  }

  test("a merge started outside Svode offers to merge its service files with the same rules", async () => {
    calls.length = 0;
    preflight = {
      type: "conflict",
      files: [ORDER, "Page.md"],
      service: [{ path: ORDER, state: "mergeable" }],
    };
    results.git_merge_service_files = [
      { type: "conflict", files: ["Page.md"], merged: [ORDER] },
    ];
    const { dialog, close, useGitStore } = await openDialog();
    const m = await import("@/paraglide/messages.js");
    try {
      const slot = dialog().querySelector<HTMLElement>(
        "[data-git-sync-stop=conflict]",
      )!;
      const row = slot.querySelector<HTMLElement>(
        "[data-git-service-file=mergeable]",
      )!;
      expect(row.textContent).toBe(`${ORDER}${m.git_sync_service_mergeable()}`);
      expect(slot.querySelector("[data-git-service-space-sync]")).toBe(null);
      const action = slot.querySelector<HTMLButtonElement>(
        "[data-git-service-merge-action]",
      )!;
      expect(action.textContent).toBe(m.git_sync_service_merge_action());

      await act(async () => {
        action.click();
      });
      await settle();

      const merge = calls.find(
        (call) => call.command === "git_merge_service_files",
      )!;
      expect(merge.args).toEqual({ spacePath: path, paths: null });
      expect(useGitStore.getState().syncStop[path]).toEqual({
        kind: "conflict",
        files: ["Page.md"],
        kinds: [],
        service: [],
      });
      // The Dialog names the merged file; only the Page is left.
      expect(
        dialog().querySelector("[data-git-service-merged]")?.textContent,
      ).toBe(m.git_sync_service_merged({ files: ORDER }));
      expect(dialog().querySelector("[data-git-service-merge-action]")).toBe(
        null,
      );
    } finally {
      await close();
    }
  });

  test("a diverged Space pointer names its reason and syncs the Space, then the merge takes it", async () => {
    calls.length = 0;
    preflight = {
      type: "conflict",
      files: ["space"],
      service: [{ path: "space", state: "space_diverged" }],
    };
    results.git_sync = [{ type: "success", publishedHead: "abc" }];
    results.git_merge_service_files = [
      { type: "success", publishedHead: "def", merged: ["space"] },
    ];
    const { dialog, close, useGitStore } = await openDialog();
    const m = await import("@/paraglide/messages.js");
    try {
      const row = dialog().querySelector<HTMLElement>(
        "[data-git-service-file=space_diverged]",
      )!;
      expect(
        row.textContent?.includes(m.git_sync_service_space_diverged()),
      ).toBe(true);
      expect(dialog().querySelector("[data-git-service-merge-action]")).toBe(
        null,
      );
      const syncSpace = row.querySelector<HTMLButtonElement>(
        "[data-git-service-space-sync]",
      )!;
      expect(syncSpace.textContent).toBe(
        m.git_sync_service_space_sync_action(),
      );

      await act(async () => {
        syncSpace.click();
      });
      await settle();

      const order = calls
        .filter(
          (call) =>
            call.command === "git_sync" ||
            call.command === "git_merge_service_files",
        )
        .map((call) => [call.command, call.args]);
      expect(order).toEqual([
        ["git_sync", { spacePath: `${path}/space`, background: false }],
        ["git_merge_service_files", { spacePath: path, paths: ["space"] }],
      ]);
      expect(path in useGitStore.getState().syncStop).toBe(false);
      expect(useGitStore.getState().syncMerged[path]).toEqual({
        files: ["space"],
        renumbered: [],
      });
    } finally {
      await close();
    }
  });

  test("a sync that renumbered repeated numbers names the items under the merged files", async () => {
    calls.length = 0;
    preflight = null;
    const SCHEMA = "tasks/schema.yaml";
    const items = [
      {
        path: "tasks/from-local.md",
        title: "From local",
        collection: "Tasks",
        from: "T-3",
        to: "T-5",
      },
      {
        path: "tasks/from-local-b.md",
        title: "From local B",
        collection: "Tasks",
        from: "T-4",
        to: "T-6",
      },
    ];
    const { dialog, close, useGitStore } = await openDialog();
    const m = await import("@/paraglide/messages.js");
    const { recordGitSyncResult } = await import("../api/git-operation-events");
    try {
      // A background sync merged the schema and renumbered two items.
      await act(async () => {
        recordGitSyncResult(
          path,
          {
            type: "success",
            publishedHead: "abc",
            merged: [SCHEMA],
            renumbered: items,
          },
          null,
        );
      });
      await settle();

      const merged = dialog().querySelector("[data-git-service-merged]");
      const renumbered = dialog().querySelector<HTMLElement>(
        "[data-git-unique-id-renumbered]",
      )!;
      expect(merged?.textContent).toBe(
        m.git_sync_service_merged({ files: SCHEMA }),
      );
      expect(renumbered.textContent).toBe(
        m.git_sync_unique_id_renumbered({
          items: items
            .map((item) => m.git_sync_unique_id_renumbered_item(item))
            .join(", "),
        }),
      );
      expect(
        renumbered.textContent?.includes("From local (Tasks): T-3 → T-5"),
      ).toBe(true);
      expect(merged?.nextElementSibling).toBe(renumbered);

      // The next sync that renumbers nothing takes the line away.
      await act(async () => {
        recordGitSyncResult(
          path,
          { type: "success", publishedHead: "def" },
          null,
        );
      });
      await settle();
      expect(dialog().querySelector("[data-git-unique-id-renumbered]")).toBe(
        null,
      );
      expect(path in useGitStore.getState().syncMerged).toBe(false);
    } finally {
      await close();
    }
  });

  test("a Space that does not sync keeps the pointer and says why", async () => {
    calls.length = 0;
    preflight = {
      type: "conflict",
      files: ["space"],
      service: [{ path: "space", state: "space_unavailable" }],
    };
    results.git_sync = [{ type: "conflict", files: ["page.md"] }];
    results.git_merge_service_files = [];
    const { dialog, close } = await openDialog();
    const m = await import("@/paraglide/messages.js");
    try {
      const row = dialog().querySelector<HTMLElement>(
        "[data-git-service-file=space_unavailable]",
      )!;
      expect(
        row.textContent?.includes(m.git_sync_service_space_unavailable()),
      ).toBe(true);
      await act(async () => {
        row
          .querySelector<HTMLButtonElement>("[data-git-service-space-sync]")!
          .click();
      });
      await settle();

      expect(
        calls.some((call) => call.command === "git_merge_service_files"),
      ).toBe(false);
      expect(
        dialog()
          .querySelector("[data-git-service-merge-error]")
          ?.textContent?.includes(m.git_sync_service_space_not_synced()),
      ).toBe(true);
      expect(
        !!dialog().querySelector("[data-git-service-file=space_unavailable]"),
      ).toBe(true);
    } finally {
      await close();
    }
  });
}
