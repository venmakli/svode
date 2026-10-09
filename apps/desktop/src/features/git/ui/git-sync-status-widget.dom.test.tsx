import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_SYNC_WIDGET_DOM !== "1") {
  test("Git sync dialog preserves the actual error and unknown counter state", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SYNC_WIDGET_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  // The active Space; a widget may show another repository.
  let activeSpacePath = "/project";
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => activeSpacePath,
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));
  test("counter refresh never replaces the publication cause or invents an empty list", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    let failFetch = false;
    mockNativeIpc(
      async (command) => {
        if (command === "git_get_user_policy") return { autoSync: true };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "git_fetch_status") {
          if (failFetch) throw "git fetch failed: connection timed out";
          return { branch: "main", ahead: 1, behind: 0, files: [] };
        }
        if (command === "git_unpushed_commits")
          return [
            {
              sha: "abc",
              message: "Saved README",
              author: "Fixture",
              timestamp: "0",
            },
          ];
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { gitSyncErrorMessage } = await import("../api/git-sync-error");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const m = await import("@/paraglide/messages.js");
    const previousLocale = getLocale();
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        for (const failed of [false, true]) {
          failFetch = failed;
          const cause = gitSyncErrorMessage({
            kind: "git_publication_blocked",
            reason: "revision_unavailable",
            child: "develop",
          });
          useGitStore.getState().setSyncError(path, cause);
          await dom.render(
            <TooltipProvider>
              <GitSyncStatusWidget
                key={`${locale}-${failed}`}
                repositoryPath={path}
              />
            </TooltipProvider>,
          );
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
          const trigger = dom.document.querySelector<HTMLButtonElement>(
            "[data-slot=tooltip-trigger]",
          )!;
          expect(!!trigger).toBe(true);
          await act(async () => {
            trigger.click();
            await new Promise((resolve) => setTimeout(resolve, 30));
          });
          const dialog =
            dom.document.querySelector<HTMLElement>("[role=dialog]")!;
          expect(!!dialog).toBe(true);
          expect(
            dialog.querySelector("[role=alert]")?.textContent?.includes(cause),
          ).toBe(true);
          expect(
            dialog.textContent.includes(m.git_sync_error_description()),
          ).toBe(false);
          expect(
            dialog.textContent.includes(
              m.git_sync_remote_unchecked_description(),
            ),
          ).toBe(false);
          expect(dialog.textContent.includes(m.git_sync_outgoing_empty())).toBe(
            false,
          );
          expect(
            dialog.textContent.includes(
              failed ? m.git_sync_outgoing_unchecked() : "Saved README",
            ),
          ).toBe(true);
          const retry = Array.from(dialog.querySelectorAll("button")).find(
            (button) => button.textContent === m.git_sync_action(),
          );
          expect(retry?.disabled).toBe(false);
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

  test("a repository other than the active Space shows its own state and refreshes like the active one", async () => {
    const dom = await createTestDom();
    activeSpacePath = "/project";
    const other = "/project/docs";
    const fetches: string[] = [];
    let ahead = 0;
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/docs.git";
        if (command === "git_publication_status") return null;
        if (command === "repository_access_get")
          return {
            status: "local",
            repositoryId: spacePath ?? other,
            generation: 1,
            checkedAt: null,
            expiresAt: null,
            lastKnownStatus: null,
            reason: null,
          };
        if (command === "git_fetch_status" || command === "git_status") {
          if (command === "git_fetch_status") fetches.push(spacePath ?? "");
          return {
            branch: spacePath === other ? "docs-main" : "main",
            ahead: spacePath === other ? ahead : 0,
            behind: 0,
            files: [],
          };
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { emit } = await import("@/platform/native/events");
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const control = () =>
      dom.document.querySelector<HTMLButtonElement>(
        "[data-repository-control]",
      )!;
    const render = (repositoryPath: string) =>
      dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={repositoryPath} />
        </TooltipProvider>,
      );
    try {
      await render(other);
      await settle();
      expect(fetches).toEqual([other]);
      expect(control().textContent?.includes("docs-main")).toBe(true);
      expect(control().querySelector("[data-git-sync-synced]") === null).toBe(
        false,
      );

      // A background commit in that repository updates its counters.
      ahead = 2;
      await act(async () => {
        await emit("git:committed", { spacePath: other });
      });
      await settle();
      expect(fetches).toEqual([other, other]);
      expect(control().textContent?.includes("2↑")).toBe(true);

      // Window focus refreshes it, as the app does for the active Space.
      ahead = 3;
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
      await settle();
      expect(fetches).toEqual([other, other, other]);
      expect(control().textContent?.includes("3↑")).toBe(true);

      // The active Space keeps its single app-level focus refresh.
      await render(activeSpacePath);
      await settle();
      fetches.length = 0;
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
      await settle();
      expect(fetches).toEqual([]);
    } finally {
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear(other);
      useGitStore.getState().clear(activeSpacePath);
      await dom.dispose();
    }
  });
}
