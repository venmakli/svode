import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_SYNC_DIALOG_DOM !== "1") {
  test("light Git sync Dialog and the sync control of the rhythm", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SYNC_DIALOG_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  let activeSpacePath = "/project";
  const space = { activeRootPath: "/project" };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => activeSpacePath,
    getSpaceSnapshot: () => ({ ...space, activeSpacePath }),
    useSpace: (select: (value: typeof space) => unknown) =>
      select({ ...space, activeSpacePath } as typeof space),
  }));
  mock.module("sonner", () => ({
    toast: Object.assign(() => {}, {
      error: () => {},
      info: () => {},
      success: () => {},
      warning: () => {},
      dismiss: () => {},
    }),
  }));

  const local = (path: string) => ({
    status: "local",
    repositoryId: path,
    generation: 1,
    checkedAt: null,
    expiresAt: null,
    lastKnownStatus: null,
    reason: null,
  });

  test("the Dialog names the branch with the last sync, what waits, and leads to the automation settings", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    let ahead = 0;
    let behind = 0;
    let autoSync = true;
    let lastSynced: number | null = null;
    mockNativeIpc(
      async (command) => {
        if (command === "git_get_user_policy") return { autoSync };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "git_sync_preflight") return null;
        if (command === "git_last_synced") return lastSynced;
        if (command === "repository_access_get") return local(path);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead, behind, files: [] };
        if (command === "git_unpushed_commits")
          return Array.from({ length: ahead }, (_, index) => ({
            sha: `sha${index}`,
            message: `Edited page ${index + 1}`,
            author: "Fixture",
            timestamp: "0",
          }));
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
    const settings: string[] = [];
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]");
    const open = async () => {
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await settle();
    };
    const close = async () => {
      await act(async () => {
        dom.document.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      await settle();
    };
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        useGitStore.getState().clear(path);
        ahead = 0;
        behind = 0;
        autoSync = true;
        lastSynced = null;
        await dom.render(
          <TooltipProvider>
            <GitSyncStatusWidget
              key={locale}
              repositoryPath={path}
              onOpenRepositorySettings={(target) => settings.push(target)}
            />
          </TooltipProvider>,
        );
        await settle();
        await open();

        // Not synced yet, everything checked and nothing waits.
        expect(dialog()!.querySelector("h2")?.textContent).toBe(
          m.git_sync_modal_title(),
        );
        expect(
          dialog()!.querySelector("[data-git-last-synced]")?.textContent,
        ).toBe(m.git_sync_dialog_never_synced({ branch: "main" }));
        if (locale === "ru")
          expect(
            dialog()!.querySelector("[data-git-last-synced]")?.textContent,
          ).toBe("main · ещё не синхронизировано");
        expect(
          dialog()!.querySelector("[data-git-sync-nothing]")?.textContent,
        ).toBe(m.git_sync_dialog_nothing());
        // Normal access shows no access row and no repository path.
        expect(
          dialog()!.querySelector("[data-repository-access-section]"),
        ).toBe(null);
        expect(dialog()!.textContent?.includes("/project")).toBe(false);
        expect(dialog()!.querySelector("[role=checkbox]")).toBe(null);
        const auto = dialog()!.querySelector("[data-git-auto-sync]")!;
        expect(auto.getAttribute("data-git-auto-sync")).toBe("on");
        expect(auto.textContent).toBe(
          `${m.git_sync_dialog_auto_on()}·${m.git_sync_dialog_configure()}`,
        );
        expect(
          Array.from(dialog()!.querySelectorAll("button")).some(
            (button) => button.textContent === m.git_sync_action(),
          ),
        ).toBe(true);

        // A finished background sync brings its time.
        await act(async () => {
          recordGitOperationOutcome({
            repository: path,
            active: false,
            background: true,
            report: { type: "success", publishedHead: "sha" },
            error: null,
            syncedAt: Date.now() - 5 * 60_000,
          });
        });
        await settle();
        const synced = dialog()!.querySelector(
          "[data-git-last-synced]",
        )?.textContent;
        expect(synced?.startsWith("main · ")).toBe(true);
        expect(
          synced === m.git_sync_dialog_never_synced({ branch: "main" }),
        ).toBe(false);
        expect(synced?.includes("5")).toBe(true);
        await close();

        // Outgoing commits by title and the number of incoming ones.
        ahead = 2;
        behind = 3;
        autoSync = false;
        await open();
        expect(
          dialog()!.querySelector("[data-git-sync-outgoing] h3")?.textContent,
        ).toBe(m.git_sync_dialog_outgoing({ count: "2" }));
        expect(
          Array.from(
            dialog()!.querySelectorAll("[data-git-sync-outgoing] li"),
          ).map((row) => row.textContent),
        ).toEqual(["Edited page 1", "Edited page 2"]);
        expect(
          dialog()!.querySelector("[data-git-sync-incoming]")?.textContent,
        ).toBe(m.git_sync_dialog_incoming({ count: "3" }));
        expect(dialog()!.querySelector("[data-git-sync-nothing]")).toBe(null);
        // The toggle changed in the settings meanwhile.
        expect(
          dialog()!
            .querySelector("[data-git-auto-sync]")
            ?.getAttribute("data-git-auto-sync"),
        ).toBe("off");
        await act(async () => {
          dialog()!
            .querySelector<HTMLButtonElement>("[data-git-auto-sync-settings]")!
            .click();
        });
        await settle();
        expect(settings.at(-1)).toBe(path);
        expect(dialog()).toBe(null);
        await dom.render(null);
      }

      // The time of the last sync is read from the device on mount.
      useGitStore.getState().clear(path);
      lastSynced = Date.now() - 60 * 60_000;
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget key="stored" repositoryPath={path} />
        </TooltipProvider>,
      );
      await settle();
      expect(useGitStore.getState().lastSynced[path]).toBe(lastSynced);
    } finally {
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear(path);
      await setLocale(previousLocale, { reload: false });
      await dom.dispose();
    }
  });

  test("only an explicit sync turns the control spinner on", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    mockNativeIpc(
      async (command) => {
        if (command === "git_get_user_policy") return { autoSync: true };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "git_sync_preflight") return null;
        if (command === "git_last_synced") return null;
        if (command === "repository_access_get") return local(path);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 0, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const spinning = () =>
      dom.document.querySelector(
        "[data-repository-control] [data-git-sync-indicator] .animate-spin",
      ) !== null;
    const event = (active: boolean, background: boolean) =>
      act(async () => {
        recordGitOperationOutcome({
          repository: path,
          active,
          background,
          report: active ? null : { type: "success", publishedHead: "sha" },
          error: null,
          syncedAt: active ? null : Date.now(),
        });
      });
    try {
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget repositoryPath={path} />
        </TooltipProvider>,
      );
      await settle();
      expect(spinning()).toBe(false);

      // A background sync on opening a Space or by the timer stays quiet.
      await event(true, true);
      await settle();
      expect(spinning()).toBe(false);
      expect(
        dom.document
          .querySelector("[data-repository-control]")
          ?.getAttribute("aria-busy"),
      ).toBe("false");
      await event(false, true);
      await settle();
      expect(spinning()).toBe(false);

      // The explicit one shows that it runs.
      await event(true, false);
      await settle();
      expect(spinning()).toBe(true);
      await event(false, false);
      await settle();
      expect(spinning()).toBe(false);

      // So does an explicit sync of the frontend, a background one does not.
      const request = useGitStore.getState().beginSync(path, false);
      await settle();
      expect(spinning()).toBe(false);
      const explicit = useGitStore.getState().beginSync(path);
      await settle();
      expect(spinning()).toBe(true);
      explicit.finish();
      await settle();
      expect(spinning()).toBe(false);
      request.finish();
    } finally {
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear(path);
      await dom.dispose();
    }
  });

  test("opening the Space and window focus are actions of the rhythm, and focus without sync shows the fetched counters", async () => {
    const dom = await createTestDom();
    activeSpacePath = "/project";
    const triggers: unknown[] = [];
    mockNativeIpc(
      async (command, args) => {
        if (command === "git_sync_trigger") {
          triggers.push(args);
          return (args as { trigger: string }).trigger === "focused"
            ? {
                branch: "main",
                ahead: 0,
                behind: 4,
                files: [],
                repository: "/project",
              }
            : null;
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("../model/git-store");
    const { useAppGitFocus } = await import("../hooks/use-app-git-focus");
    function Host() {
      useAppGitFocus();
      return null;
    }
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    try {
      await dom.render(<Host />);
      await settle();
      expect(triggers).toEqual([{ spacePath: "/project", trigger: "opened" }]);
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
      await settle();
      expect(triggers.at(-1)).toEqual({
        spacePath: "/project",
        trigger: "focused",
      });
      expect(useGitStore.getState().remoteStatuses["/project"]?.behind).toBe(4);
    } finally {
      await dom.render(null);
      clearNativeMocks();
      useGitStore.getState().clear("/project");
      await dom.dispose();
    }
  });
}
