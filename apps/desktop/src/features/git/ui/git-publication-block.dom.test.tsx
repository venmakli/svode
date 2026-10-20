import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_PUBLICATION_BLOCK_DOM !== "1") {
  test("Git sync Dialogs list the Spaces that stop the project sync", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PUBLICATION_BLOCK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  let activeSpacePath = "/project";
  const longName =
    "Compliance and regulatory documentation of the whole company";
  const space = {
    activeRootPath: "/project",
    spaces: [
      { name: longName, path: "/project/compliance" },
      { name: "Legal", path: "/project/legal" },
      { name: "Operations", path: "/project/ops" },
      { name: "Docs", path: "/project/docs" },
    ],
  };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => activeSpacePath,
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));
  const toasts: { kind: string; message: unknown }[] = [];
  const record = (kind: string) => (message: unknown) => {
    toasts.push({ kind, message });
  };
  mock.module("sonner", () => ({
    toast: Object.assign(record("default"), {
      error: record("error"),
      info: record("info"),
      success: record("success"),
      warning: record("warning"),
      dismiss: () => {},
      get: () => undefined,
    }),
  }));

  const block = {
    kind: "git_publication_blocked",
    repository: "/project",
    reason: "spaces",
    spaces: [
      { path: "archive", class: "local_commits" },
      { path: "compliance", class: "local_commits" },
      { path: "legal", class: "local_commits" },
      { path: "ops", class: "missing" },
    ],
  };
  const access = (spacePath: string | undefined) => ({
    status: spacePath === "/project/legal" ? "read_only" : "writable",
    repositoryId: spacePath ?? "/project",
    generation: 1,
    checkedAt: null,
    expiresAt: null,
    lastKnownStatus: null,
    reason: null,
  });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

  test("the project Dialog lists every Space with its name and what it needs", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    let syncError: unknown = block;
    let fetches = 0;
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "repository_access_get") return access(spacePath);
        if (command === "git_fetch_status" || command === "git_status") {
          if (command === "git_fetch_status") fetches++;
          return { branch: "main", ahead: 2, behind: 0, files: [] };
        }
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync") throw syncError;
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
    const rows = () =>
      Array.from(
        dialog().querySelectorAll<HTMLElement>(
          "[data-publication-blocked-space]",
        ),
      );
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        syncError = block;
        useGitStore.getState().clear(path);
        toasts.length = 0;
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

        // An explicit refusal is a stop with its own toast, not a failure.
        expect(toasts).toEqual([
          { kind: "info", message: m.git_sync_publication_blocked_status() },
        ]);
        const notice = dialog().querySelector<HTMLElement>(
          "[data-git-publication-block]",
        )!;
        expect(
          notice.textContent.includes(m.git_publication_block_title()),
        ).toBe(true);
        expect(
          dialog().querySelector("[data-slot=alert].text-destructive"),
        ).toBe(null);
        expect(
          rows().map((row) => [
            row.querySelector("span")!.textContent,
            row.querySelector("span")!.title,
            row.lastElementChild!.textContent,
            row.dataset.publishable === "true",
          ]),
        ).toEqual([
          ["archive", "archive", m.git_publication_block_local_commits(), true],
          [longName, longName, m.git_publication_block_local_commits(), true],
          ["Legal", "Legal", m.git_publication_block_read_only(), false],
          [
            "Operations",
            "Operations",
            m.git_publication_block_missing(),
            false,
          ],
        ]);
        expect(
          rows()[1].querySelector("span")!.classList.contains("truncate"),
        ).toBe(true);
        // Outgoing commits, counters and the sync action stay below.
        expect(
          dialog().textContent.includes(m.git_sync_outgoing_section()),
        ).toBe(true);
        expect(button(m.git_sync_action())?.disabled).toBe(false);

        // The header shows a stop without the red error.
        const indicator = control().querySelector<HTMLElement>(
          "[data-git-sync-indicator] svg",
        )!;
        expect(indicator.dataset.gitSyncStopped).toBe("true");
        expect(indicator.dataset.gitSyncError).toBe(undefined);
        expect(indicator.classList.contains("text-destructive")).toBe(false);
        expect(
          control()
            .getAttribute("aria-label")!
            .includes(m.git_sync_publication_blocked_status()),
        ).toBe(true);

        // Counter refreshes keep the list.
        const before = fetches;
        const { refreshGitRemoteStatus } =
          await import("../api/git-status-actions");
        await act(async () => {
          await refreshGitRemoteStatus(path);
        });
        await settle();
        expect(fetches).toBe(before + 1);
        expect(rows().length).toBe(4);

        // A refusal without a list keeps the red error.
        syncError = {
          kind: "git_publication_blocked",
          repository: "/project",
          reason: "target_changed",
        };
        toasts.length = 0;
        await act(async () => {
          button(m.git_sync_action())!.click();
        });
        await settle();
        expect(rows().length).toBe(0);
        expect(
          dialog()
            .querySelector("[data-slot=alert].text-destructive")
            ?.textContent.includes(m.git_publication_target_changed()),
        ).toBe(true);
        expect(toasts).toEqual([
          { kind: "error", message: m.git_sync_failed() },
        ]);
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

  test("the Space Dialog names the Spaces that kept the project version from syncing", async () => {
    const dom = await createTestDom();
    const path = "/project/docs";
    activeSpacePath = path;
    const parent = {
      repository: "/project",
      pointer: "local",
      target: "target",
      error: {
        ...block,
        spaces: [
          { path: "compliance", class: "local_commits" },
          { path: "ops", class: "outside_branch" },
        ],
      },
    };
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/docs.git";
        if (command === "git_publication_status") return null;
        if (command === "repository_access_get") return access(spacePath);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 0, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync")
          return { type: "success", publishedHead: "head", parent };
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
    const control = () =>
      dom.document.querySelector<HTMLButtonElement>(
        "[data-repository-control]",
      )!;
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]")!;
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        useGitStore.getState().clear(path);
        toasts.length = 0;
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
          Array.from(dialog().querySelectorAll("button"))
            .find((button) => button.textContent === m.git_sync_action())!
            .click();
        });
        await settle();

        expect(toasts).toEqual([
          { kind: "info", message: m.git_publication_blocked_summary() },
        ]);
        const text = dialog().textContent;
        expect(text.includes(m.git_publication_blocked_summary())).toBe(true);
        expect(text.includes(m.git_publication_block_title())).toBe(true);
        expect(text.includes(m.git_sync_publication_blocked_status())).toBe(
          false,
        );
        expect(
          Array.from(
            dialog().querySelectorAll<HTMLElement>(
              "[data-publication-blocked-space]",
            ),
          ).map((row) => row.textContent),
        ).toEqual([
          `${longName}${m.git_publication_block_local_commits()}`,
          `Operations${m.git_publication_block_outside_branch()}`,
        ]);
        // The project result is the only place of the list in the Space Dialog.
        expect(dialog().querySelector("[data-git-publication-block]")).toBe(
          null,
        );
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

  test("a retry of the project version stopped by this Space lists it instead of a failure", async () => {
    const dom = await createTestDom();
    const path = "/project/docs";
    activeSpacePath = path;
    const retries: unknown[] = [];
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/docs.git";
        if (command === "git_publication_status")
          return {
            childHead: "head",
            child: "published",
            parent: { repository: "/project", pointer: "local", target: "t" },
          };
        if (command === "repository_access_get") return access(spacePath);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 0, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_retry_parent") {
          retries.push(args);
          throw {
            ...block,
            spaces: [{ path: "docs", class: "local_commits" }],
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
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]")!;
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        useGitStore.getState().clear(path);
        await dom.render(
          <TooltipProvider>
            <GitSyncStatusWidget key={locale} repositoryPath={path} />
          </TooltipProvider>,
        );
        await settle();
        await act(async () => {
          dom.document
            .querySelector<HTMLButtonElement>("[data-repository-control]")!
            .click();
        });
        await settle();
        await act(async () => {
          Array.from(dialog().querySelectorAll("button"))
            .find((button) => button.textContent === m.git_publication_retry())!
            .click();
        });
        await settle();
        expect(retries.length > 0).toBe(true);
        const text = dialog().textContent;
        expect(text.includes(m.git_publication_failed())).toBe(false);
        expect(text.includes(m.git_publication_block_title())).toBe(true);
        expect(
          Array.from(
            dialog().querySelectorAll<HTMLElement>(
              "[data-publication-blocked-space]",
            ),
          ).map((row) => row.textContent),
        ).toEqual([`Docs${m.git_publication_block_local_commits()}`]);
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
