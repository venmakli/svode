import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_PUBLICATION_NEWER_DOM !== "1") {
  test("a Space behind the project pointer offers only its own sync", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PUBLICATION_NEWER_DOM: "1" },
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
  test("a Space behind the project pointer offers only its own sync", async () => {
    const dom = await createTestDom();
    const path = "/project/docs";
    let pointer = "newer";
    const syncs: string[] = [];
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/docs.git";
        if (command === "git_publication_status")
          return {
            childHead: "old",
            child: "published",
            parent: {
              repository: "/project",
              pointer,
              target: "target",
              // A project-side cause must not leak into the newer state.
              error:
                pointer === "newer"
                  ? { kind: "repository_access_denied", status: "read_only" }
                  : undefined,
            },
          };
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
          syncs.push(spacePath ?? "");
          pointer = "published";
          return {
            type: "success",
            publishedHead: "new",
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
      dom.document.querySelector<HTMLElement>("[role=dialog]");
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        for (const state of ["pending", "newer"] as const) {
          pointer = state;
          useGitStore.getState().clear(path);
          await dom.render(
            <TooltipProvider>
              <GitSyncStatusWidget
                key={`${locale}-${state}`}
                repositoryPath={path}
              />
            </TooltipProvider>,
          );
          await settle();
          await act(async () => {
            control().click();
          });
          await settle();
          const text = dialog()!.textContent ?? "";
          const buttons = Array.from(dialog()!.querySelectorAll("button"));
          const retry = buttons.find(
            (button) => button.textContent === m.git_publication_retry(),
          );
          const sync = buttons.find(
            (button) => button.textContent === m.git_sync_action(),
          );
          // The header indicator warns only about a pointer still to publish.
          const synced =
            control().querySelector("[data-git-sync-synced]") !== null;
          if (state === "pending") {
            expect(text.includes(m.git_publication_parent_pending())).toBe(
              true,
            );
            expect(!!retry).toBe(true);
            expect(synced).toBe(false);
            await dom.render(null);
            continue;
          }
          expect(text.includes(m.git_publication_newer_summary())).toBe(true);
          expect(text.includes(m.git_publication_parent_newer())).toBe(true);
          expect(text.includes(m.git_publication_parent_pending())).toBe(false);
          expect(text.includes(m.git_publication_read_only())).toBe(false);
          expect(!!retry).toBe(false);
          expect(synced).toBe(true);
          expect(
            control()
              .getAttribute("aria-label")
              ?.includes(m.git_publication_parent_newer()),
          ).toBe(false);
          expect(sync?.disabled).toBe(false);

          await act(async () => {
            sync!.click();
          });
          await settle();
          expect(syncs.at(-1)).toBe(path);
          expect(
            dom.document.body.textContent?.includes(
              m.git_publication_newer_summary(),
            ),
          ).toBe(false);
          await dom.render(null);
        }
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
