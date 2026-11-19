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
  }, 30_000);
} else {
  // The active Space; a widget may show another repository.
  let activeSpacePath = "/project";
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => activeSpacePath,
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));
  const toasts: unknown[] = [];
  const record = (message: unknown) => {
    toasts.push(message);
  };
  mock.module("sonner", () => ({
    toast: Object.assign(record, {
      error: record,
      info: record,
      success: record,
      warning: record,
      dismiss: () => {},
      get: () => undefined,
    }),
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
        if (command === "git_last_synced") return null;
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
          // A project-level refusal stays a sync error; a list of Spaces is a stop.
          const cause = gitSyncErrorMessage({
            kind: "git_publication_blocked",
            repository: path,
            reason: "revision_unavailable",
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
          // The error takes the body of the Dialog: no list, no empty state.
          expect(dialog.querySelector("[data-git-sync-nothing]")).toBe(null);
          expect(dialog.querySelector("[data-git-sync-outgoing]")).toBe(null);
          expect(dialog.textContent.includes("Saved README")).toBe(false);
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
        if (command === "git_last_synced") return null;
        if (
          command === "git_fetch_status" ||
          command === "git_status" ||
          // With sync off, focus fetches the counters through the rhythm.
          command === "git_sync_trigger"
        ) {
          if (command !== "git_status") fetches.push(spacePath ?? "");
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

  test("a pull blocked by local files names them in the Dialog after background and explicit sync", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    const blocked = {
      kind: "git_pull_blocked",
      repository: path,
      files: [".gitattributes", ".gitignore"],
    };
    mockNativeIpc(
      async (command) => {
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "git_last_synced") return null;
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
          return { branch: "main", ahead: 0, behind: 1, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync") throw blocked;
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const m = await import("@/paraglide/messages.js");
    const previousLocale = getLocale();
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const alertText = () =>
      dom.document.querySelector("[role=dialog]")?.querySelector("[role=alert]")
        ?.textContent ?? null;
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        const expected = m.git_sync_pull_blocked({
          files: ".gitattributes, .gitignore",
        });
        if (locale === "ru")
          expect(String(expected)).toBe(
            "Входящие изменения затрагивают файлы с несохранёнными правками: .gitattributes, .gitignore. Сохраните или отмените эти правки и повторите синхронизацию.",
          );

        // Background sync records the refusal on the repository, without toasts.
        toasts.length = 0;
        recordGitOperationOutcome({
          repository: path,
          active: false,
          report: null,
          error: blocked,
        });
        expect(toasts).toEqual([]);
        await dom.render(
          <TooltipProvider>
            <GitSyncStatusWidget key={locale} repositoryPath={path} />
          </TooltipProvider>,
        );
        await settle();
        expect(
          dom.document.querySelector("[data-git-sync-error]") === null,
        ).toBe(false);
        await act(async () => {
          dom.document
            .querySelector<HTMLButtonElement>("[data-repository-control]")!
            .click();
        });
        await settle();
        expect(alertText()).toBe(expected);

        // An explicit retry that is refused again shows the same text.
        useGitStore.getState().setSyncError(path, null);
        await settle();
        expect(alertText()).toBe(null);
        const retry = Array.from(
          dom.document.querySelectorAll<HTMLButtonElement>(
            "[role=dialog] button",
          ),
        ).find((button) => button.textContent === m.git_sync_action());
        await act(async () => {
          retry!.click();
        });
        await settle();
        expect(alertText()).toBe(expected);
        await dom.render(null);
        useGitStore.getState().clear(path);
      }
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
      await setLocale(previousLocale, { reload: false });
    }
  });

  test("a sync step Svode stopped at its time limit or without transfer progress is named, not an unknown cause, after background and explicit sync", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    const timedOut = {
      kind: "git_sync_failed",
      repository: "lfs-test",
      stage: "push",
      cause: "timed_out",
    };
    const stalled = {
      kind: "git_sync_failed",
      repository: "lfs-test",
      stage: "push",
      cause: "transfer_stalled",
      transfer: {
        direction: "upload",
        path: "media/video.mov",
        size: 99_614_720,
      },
    };
    let refusal: object = timedOut;
    mockNativeIpc(
      async (command) => {
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "git_last_synced") return null;
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
          return { branch: "main", ahead: 1, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync") throw refusal;
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const m = await import("@/paraglide/messages.js");
    const previousLocale = getLocale();
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const alertText = () =>
      dom.document.querySelector("[role=dialog]")?.querySelector("[role=alert]")
        ?.textContent ?? null;
    const cases = [
      {
        error: timedOut,
        expected: {
          en: "lfs-test: Could not publish the changes. The server didn't respond in time. Check the connection and try again.",
          ru: "lfs-test: Не удалось опубликовать изменения. Сервер не ответил вовремя. Проверьте подключение и повторите.",
        },
      },
      {
        error: stalled,
        expected: {
          en: "lfs-test: Could not publish the changes. Sending the file “video.mov” (95 MB) stopped: no data was transferred for 2 minutes. Check the connection and sync again — files already sent won't be sent again.",
          ru: "lfs-test: Не удалось опубликовать изменения. Отправка файла «video.mov» (95 МБ) остановлена: 2 минуты не было передачи данных. Проверьте подключение и синхронизируйте ещё раз — уже отправленные файлы не отправятся повторно.",
        },
      },
    ];
    try {
      for (const [locale, { error, expected }] of (
        ["en", "ru"] as const
      ).flatMap((locale) => cases.map((item) => [locale, item] as const))) {
        await setLocale(locale, { reload: false });
        refusal = error;

        // Background sync records the failure on the repository, without toasts.
        toasts.length = 0;
        recordGitOperationOutcome({
          repository: path,
          active: false,
          report: null,
          error,
        });
        expect(toasts).toEqual([]);
        await dom.render(
          <TooltipProvider>
            <GitSyncStatusWidget
              key={`${locale}-${error.cause}`}
              repositoryPath={path}
            />
          </TooltipProvider>,
        );
        await settle();
        // The status shows the sync error like any other failed sync.
        expect(
          dom.document.querySelector("[data-git-sync-error]") === null,
        ).toBe(false);
        await act(async () => {
          dom.document
            .querySelector<HTMLButtonElement>("[data-repository-control]")!
            .click();
        });
        await settle();
        expect(alertText()).toBe(expected[locale]);
        expect(alertText()?.includes(m.git_save_cause_unknown())).toBe(false);

        // An explicit retry that runs out of time again shows the same text
        // and the toast of a failed sync.
        useGitStore.getState().setSyncError(path, null);
        await settle();
        expect(alertText()).toBe(null);
        const retry = Array.from(
          dom.document.querySelectorAll<HTMLButtonElement>(
            "[role=dialog] button",
          ),
        ).find((button) => button.textContent === m.git_sync_action());
        toasts.length = 0;
        await act(async () => {
          retry!.click();
        });
        await settle();
        expect(alertText()).toBe(expected[locale]);
        expect(toasts).toEqual([m.git_sync_failed()]);
        await dom.render(null);
        useGitStore.getState().clear(path);
      }
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
      await setLocale(previousLocale, { reload: false });
    }
  });

  test("a transfer longer than about two seconds shows its line with the file progress above the Dialog buttons", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    mockNativeIpc(
      async (command) => {
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "git_last_synced") return null;
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
          return { branch: "main", ahead: 1, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { listenGitTransfers, TRANSFER_SHOWN_AFTER_MS } =
      await import("../api/git-transfer-events");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { emit } = await import("@/platform/native/events");
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const previousLocale = getLocale();
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const report = (bytes: number | null) =>
      act(async () => {
        await emit("git:transfer", {
          repository: path,
          progress:
            bytes == null
              ? null
              : {
                  direction: "upload",
                  file: 1,
                  files: 2,
                  path: "media/video.mov",
                  bytes,
                  size: 99_614_720,
                },
        });
      });
    const line = () =>
      dom.document.querySelector<HTMLElement>("[data-git-transfer-progress]");
    const stop = await listenGitTransfers();
    try {
      await setLocale("ru", { reload: false });
      expect(TRANSFER_SHOWN_AFTER_MS).toBe(2000);
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} />
        </TooltipProvider>,
      );
      await wait(20);
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await wait(20);
      const dialog = dom.document.querySelector<HTMLElement>("[role=dialog]")!;
      expect(!!dialog).toBe(true);

      // A short transfer shows nothing.
      await report(1_048_576);
      await wait(300);
      await report(null);
      await wait(TRANSFER_SHOWN_AFTER_MS);
      expect(line()).toBe(null);

      // A longer one shows its line once it lasted past the threshold.
      await report(1_048_576);
      await wait(TRANSFER_SHOWN_AFTER_MS - 500);
      expect(line()).toBe(null);
      await report(12_582_912);
      await wait(700);
      expect(line()!.textContent).toBe(
        "Отправка 1 из 2 · video.mov · 12 из 95 МБ",
      );
      const progress =
        line()!.querySelector<HTMLElement>("[role=progressbar]")!;
      const indicator = progress.querySelector<HTMLElement>(
        '[data-slot="progress-indicator"]',
      )!;
      expect(indicator.style.transform).toBe(
        `translateX(-${100 - (12_582_912 / 99_614_720) * 100}%)`,
      );
      expect(
        dom.document.getElementById(progress.getAttribute("aria-labelledby")!)
          ?.textContent,
      ).toBe(line()!.textContent);
      // Over the buttons: after the body, before the footer.
      const footer = dialog.querySelector('[data-slot="dialog-footer"]')!;
      expect(line()!.nextElementSibling).toBe(footer);

      // It follows the transfer and leaves when it ends.
      await report(49_807_360);
      expect(line()!.textContent).toBe(
        "Отправка 1 из 2 · video.mov · 48 из 95 МБ",
      );
      await report(null);
      expect(line()).toBe(null);
      expect(useGitStore.getState().transfers[path]).toBeUndefined();
    } finally {
      stop();
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear(path);
      await dom.dispose();
      await setLocale(previousLocale, { reload: false });
    }
  }, 15_000);
}
