import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_PUBLICATION_HELD_DOM !== "1") {
  test("a Space sync that keeps the project pointer local offers the project sync", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PUBLICATION_HELD_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => "/project/docs",
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));
  test("a Space sync that keeps the project pointer local offers the project sync", async () => {
    const dom = await createTestDom();
    const path = "/project/docs";
    let pointer: string | null = null;
    const retries: unknown[] = [];
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/docs.git";
        // The reader never carries the count; the sync result does.
        if (command === "git_publication_status")
          return (
            pointer && {
              childHead: "head",
              child: "published",
              parent: { repository: "/project", pointer, target: "target" },
            }
          );
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: spacePath ?? path,
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 0, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync") {
          pointer = "local";
          return {
            type: "success",
            publishedHead: "head",
            parent: {
              repository: "/project",
              pointer,
              target: "target",
              unpublishedCommits: 3,
            },
          };
        }
        if (command === "git_retry_parent") {
          retries.push(args);
          pointer = "published";
          return {
            childHead: "head",
            child: "published",
            parent: { repository: "/project", pointer, target: "target" },
          };
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const m = await import("@/paraglide/messages.js");
    const previousLocale = getLocale();
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const control = () =>
      dom.document.querySelector<HTMLButtonElement>(
        "[data-repository-control]",
      )!;
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]")!;
    const button = (label: string) =>
      Array.from(dialog().querySelectorAll("button")).find(
        (candidate) => candidate.textContent === label,
      );
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        pointer = null;
        useGitStore.getState().clear(path);
        await dom.render(
          <TooltipProvider>
            <GitSyncStatusWidget key={locale} repositoryPath={path} />
          </TooltipProvider>,
        );
        await settle();
        await act(async () => {
          control().click();
        });
        await settle();
        await act(async () => {
          button(m.git_sync_action())!.click();
        });
        await settle();

        const text = dialog().textContent ?? "";
        expect(text.includes(m.git_publication_held_summary())).toBe(true);
        expect(text.includes(m.git_publication_parent_local())).toBe(true);
        expect(text.includes(m.git_publication_held({ count: "3" }))).toBe(
          true,
        );
        expect(text.includes(m.git_publication_partial())).toBe(false);
        expect(button(m.git_publication_retry())).toBe(undefined);
        // The header keeps its warning about the pointer still to publish.
        expect(control().querySelector("[data-git-sync-synced]") !== null).toBe(
          false,
        );

        // Reading the publication again keeps the reason of the Space sync.
        const { refreshGitPublication } =
          await import("../api/git-publication-actions");
        await act(async () => {
          await refreshGitPublication(path);
        });
        await settle();
        expect(
          (dialog().textContent ?? "").includes(
            m.git_publication_held({ count: "3" }),
          ),
        ).toBe(true);

        await act(async () => {
          button(m.git_publication_sync_project())!.click();
        });
        await settle();
        expect(retries.at(-1)).toEqual({
          spacePath: path,
          expectedHead: "head",
          expectedParent: "/project",
          expectedTarget: "target",
        });
        expect(
          (dom.document.body.textContent ?? "").includes(
            m.git_publication_held_summary(),
          ),
        ).toBe(false);
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
}
