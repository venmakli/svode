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
  test("counter refresh never replaces the publication cause or invents an empty list", async () => {
    const dom = await createTestDom();
    const path = "/project";
    const space = { activeRootPath: path };
    mock.module("@/features/space", () => ({
      selectActiveSpacePath: () => path,
      useSpace: (select: (value: typeof space) => unknown) => select(space),
    }));
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
              <GitSyncStatusWidget key={`${locale}-${failed}`} />
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
}
