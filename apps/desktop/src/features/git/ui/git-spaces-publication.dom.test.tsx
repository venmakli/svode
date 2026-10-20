import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_SPACES_PUBLICATION_DOM !== "1") {
  test("Git sync Dialogs publish the Spaces that stop the project sync", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SPACES_PUBLICATION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  let activeSpacePath = "/project";
  const space = {
    activeRootPath: "/project",
    spaces: [
      { name: "Compliance", path: "/project/compliance" },
      { name: "Legal", path: "/project/legal" },
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

  const blockError = (spaces: { path: string; class: string }[]) => ({
    kind: "git_publication_blocked",
    repository: "/project",
    reason: "spaces",
    spaces,
  });
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
  const syncState = (repository: string, active: boolean, extra = {}) => ({
    repository,
    active,
    report: null,
    error: null,
    ...extra,
  });

  async function setup(
    dom: Awaited<ReturnType<typeof createTestDom>>,
    path: string,
  ) {
    const { useGitStore } = await import("../model/git-store");
    const { useSpacesPublicationStore } =
      await import("../model/spaces-publication");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const m = await import("@/paraglide/messages.js");
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]");
    const button = (label: string) =>
      Array.from(dialog()?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent === label,
      );
    const rows = () =>
      Array.from(
        dialog()?.querySelectorAll<HTMLElement>(
          "[data-publication-blocked-space]",
        ) ?? [],
      );
    const row = (gitlink: string) =>
      rows().find((item) => item.dataset.publicationBlockedSpace === gitlink)!;
    const opened: string[] = [];
    const render = async (key: string) => {
      useGitStore.getState().clear(path);
      useGitStore.getState().clear("/project");
      useSpacesPublicationStore.setState({ runs: {} });
      toasts.length = 0;
      await dom.render(
        <TooltipProvider>
          <GitSyncStatusWidget
            key={key}
            repositoryPath={path}
            onOpenSpace={(spacePath) => opened.push(spacePath)}
          />
        </TooltipProvider>,
      );
      await settle();
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await settle();
    };
    return { m, dialog, button, rows, row, render, opened, useGitStore };
  }

  test("the project Dialog publishes the publishable Spaces row by row and continues after a partial result", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    const { emit } = await import("@/platform/native/events");
    const requests: { projectPath: string; spaces: string[] }[] = [];
    let release: () => void = () => {};
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "repository_access_get") return access(spacePath);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 2, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync")
          throw blockError([
            { path: "compliance", class: "local_commits" },
            { path: "docs", class: "local_commits" },
            { path: "legal", class: "local_commits" },
          ]);
        if (command === "git_publish_spaces") {
          const request = args as { projectPath: string; spaces: string[] };
          requests.push(request);
          if (requests.length % 2 === 0) {
            await emit("git:sync-state", syncState("/project/docs", true));
            await emit(
              "git:sync-state",
              syncState("/project/docs", false, {
                report: { type: "success" },
              }),
            );
            return { spaces: [{ path: "docs", status: "published" }] };
          }
          await emit("git:sync-state", syncState("/project/compliance", true));
          await new Promise<void>((resolve) => (release = resolve));
          await emit(
            "git:sync-state",
            syncState("/project/compliance", false, {
              report: { type: "success" },
            }),
          );
          await emit("git:sync-state", syncState("/project/docs", true));
          await emit(
            "git:sync-state",
            syncState("/project/docs", false, {
              report: { type: "authRequired" },
            }),
          );
          return {
            spaces: [
              { path: "compliance", status: "published" },
              {
                path: "docs",
                status: "failed",
                report: { type: "authRequired" },
              },
            ],
          };
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const previousLocale = getLocale();
    const { m, dialog, button, rows, row, render, opened, useGitStore } =
      await setup(dom, path);
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        await render(locale);
        await act(async () => {
          button(m.git_sync_action())!.click();
        });
        await settle();

        // A read-only Space in the list: only the others are published,
        // and the project cannot sync after them.
        const action = button(m.git_publication_publish_spaces())!;
        expect(action.dataset.spacesPublicationAction).toBe("true");
        expect(button(m.git_sync_action())).toBe(undefined);
        await act(async () => {
          action.click();
        });
        await settle();

        expect(requests.at(-1)).toEqual({
          projectPath: "/project",
          spaces: ["compliance", "docs"],
        });
        // The running Space shows its spinner; the footer waits.
        expect(row("compliance").dataset.publicationStep).toBe("running");
        expect(
          row("compliance").querySelector("[data-step-icon=running]") !== null,
        ).toBe(true);
        expect(row("compliance").lastElementChild!.textContent).toBe(
          m.git_publication_space_publishing(),
        );
        expect(row("docs").dataset.publicationStep).toBe(undefined);
        expect(button(m.git_publication_publish_spaces())!.disabled).toBe(true);
        expect(
          dom.document.querySelector(
            "[data-repository-control] [data-git-sync-indicator] .animate-spin",
          ) !== null,
        ).toBe(true);

        await act(async () => {
          release();
        });
        await settle();

        // Partial result: the project did not sync, each row tells its fate.
        expect(
          dialog()!.querySelector("[data-spaces-publication-partial]")!
            .textContent,
        ).toBe(
          m.git_publication_spaces_partial({ published: "1", total: "2" }),
        );
        expect(
          rows().map((item) => [
            item.dataset.publicationBlockedSpace,
            item.dataset.publicationStep,
          ]),
        ).toEqual([
          ["compliance", "published"],
          ["docs", "failed"],
          ["legal", undefined],
        ]);
        expect(
          row("compliance").querySelector("[data-step-icon=published]") !==
            null,
        ).toBe(true);
        expect(row("compliance").lastElementChild!.textContent).toBe(
          m.git_publication_space_published(),
        );
        expect(
          row("docs").querySelector("[data-step-icon=failed]") !== null,
        ).toBe(true);
        expect(
          row("docs").textContent.includes(m.git_sync_auth_required()),
        ).toBe(true);
        expect(row("legal").lastElementChild!.textContent).toBe(
          m.git_publication_block_read_only(),
        );
        // Only the refused Space links to its own Dialog.
        expect(row("compliance").querySelector("button")).toBe(null);
        expect(row("legal").querySelector("button")).toBe(null);
        const open = row("docs").querySelector("button")!;
        expect(open.textContent).toBe(m.git_publication_open_space());
        expect(open.getAttribute("aria-label")).toBe(
          m.git_publication_open_space_named({ name: "Docs" }),
        );
        expect(
          dialog()!.querySelector("[data-slot=alert].text-destructive"),
        ).toBe(null);
        expect(toasts).toEqual([
          { kind: "info", message: m.git_sync_publication_blocked_status() },
        ]);

        // The same action continues with the Space still to publish.
        await act(async () => {
          button(m.git_publication_publish_spaces())!.click();
        });
        await settle();
        expect(requests.at(-1)).toEqual({
          projectPath: "/project",
          spaces: ["docs"],
        });
        expect(
          dialog()!.querySelector("[data-spaces-publication-partial]")!
            .textContent,
        ).toBe(
          m.git_publication_spaces_partial({ published: "1", total: "1" }),
        );
        expect(row("compliance").dataset.publicationStep).toBe("published");
        expect(row("docs").dataset.publicationStep).toBe("published");
        // Nothing publishable is left: sync returns for a retry after Git.
        expect(button(m.git_publication_publish_spaces())).toBe(undefined);
        expect(button(m.git_sync_action())?.disabled).toBe(false);
        expect(
          useGitStore.getState().publicationBlock["/project"]?.spaces.length,
        ).toBe(3);

        await act(async () => {
          useGitStore.getState().setPublicationBlock("/project", null);
        });
        await settle();
        expect(rows().length).toBe(0);
        await dom.render(null);
      }

      // The refused Space opens through the host and leaves this Dialog.
      await render("open");
      await act(async () => {
        button(m.git_sync_action())!.click();
      });
      await settle();
      await act(async () => {
        button(m.git_publication_publish_spaces())!.click();
      });
      await settle();
      await act(async () => {
        release();
      });
      await settle();
      await act(async () => {
        row("docs").querySelector("button")!.click();
      });
      await settle();
      expect(opened).toEqual(["/project/docs"]);
      expect(dialog()).toBe(null);
    } finally {
      useGitStore.getState().clear(path);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
      await setLocale(previousLocale, { reload: false });
    }
  });

  test("publishing every Space syncs the project and finishes the Dialog", async () => {
    const dom = await createTestDom();
    const path = "/project";
    activeSpacePath = path;
    let proof: unknown = null;
    mockNativeIpc(
      async (command, args) => {
        const spacePath = (args as { spacePath?: string } | undefined)
          ?.spacePath;
        if (command === "git_get_user_policy") return { autoSync: false };
        if (command === "git_get_remote")
          return "https://example.test/project.git";
        if (command === "git_publication_status") return null;
        if (command === "repository_access_get") return access(spacePath);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 2, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_sync")
          throw blockError([
            { path: "compliance", class: "local_commits" },
            { path: "docs", class: "local_commits" },
          ]);
        if (command === "git_publish_spaces") {
          if (proof) throw proof;
          return {
            spaces: [
              { path: "compliance", status: "published" },
              { path: "docs", status: "published" },
            ],
            project: {
              type: "success",
              remoteStatus: { branch: "main", ahead: 0, behind: 0, files: [] },
            },
          };
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const previousLocale = getLocale();
    const { m, dialog, button, rows, render, useGitStore } = await setup(
      dom,
      path,
    );
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        proof = null;
        await render(locale);
        await act(async () => {
          button(m.git_sync_action())!.click();
        });
        await settle();
        expect(rows().length).toBe(2);
        await act(async () => {
          button(m.git_publication_publish_and_sync())!.click();
        });
        await settle();
        expect(dialog()).toBe(null);
        expect(toasts.at(-1)).toEqual({
          kind: "success",
          message: m.git_publication_spaces_synced({ count: "2" }),
        });
        expect("/project" in useGitStore.getState().publicationBlock).toBe(
          false,
        );

        // A refusal of the project proof is a sync error of the project.
        proof = "The project remote moved ahead";
        await render(`${locale}-proof`);
        await act(async () => {
          button(m.git_sync_action())!.click();
        });
        await settle();
        toasts.length = 0;
        await act(async () => {
          button(m.git_publication_publish_and_sync())!.click();
        });
        await settle();
        expect(rows().length).toBe(0);
        expect(
          dialog()!
            .querySelector("[data-slot=alert].text-destructive")
            ?.textContent.includes("The project remote moved ahead"),
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

  test("the Space Dialog publishes the Spaces its project version waits for", async () => {
    const dom = await createTestDom();
    const path = "/project/docs";
    activeSpacePath = path;
    let synced = false;
    const requests: unknown[] = [];
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
            parent: {
              repository: "/project",
              pointer: synced ? "published" : "local",
              target: "t",
              ...(synced
                ? {}
                : {
                    error: blockError([
                      { path: "compliance", class: "local_commits" },
                    ]),
                  }),
            },
          };
        if (command === "repository_access_get") return access(spacePath);
        if (command === "git_fetch_status" || command === "git_status")
          return { branch: "main", ahead: 0, behind: 0, files: [] };
        if (command === "git_unpushed_commits") return [];
        if (command === "git_publish_spaces") {
          requests.push(args);
          synced = true;
          return {
            spaces: [{ path: "compliance", status: "published" }],
            project: { type: "success" },
          };
        }
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { getLocale, setLocale } = await import("@/paraglide/runtime.js");
    const previousLocale = getLocale();
    const { m, dialog, button, rows, render, useGitStore } = await setup(
      dom,
      path,
    );
    try {
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        synced = false;
        await render(locale);
        expect(rows().map((item) => item.textContent)).toEqual([
          `Compliance${m.git_publication_block_local_commits()}`,
        ]);
        // The action takes the place of the project version retry.
        expect(button(m.git_publication_retry())).toBe(undefined);
        await act(async () => {
          button(m.git_publication_publish_and_sync())!.click();
        });
        await settle();
        expect(requests.at(-1)).toEqual({
          projectPath: "/project",
          spaces: ["compliance"],
        });
        expect(dialog()).toBe(null);
        expect(toasts.at(-1)).toEqual({
          kind: "success",
          message: m.git_publication_spaces_synced({ count: "1" }),
        });
        // The reread project version of this Space is published.
        expect(useGitStore.getState().publications[path]?.parent.pointer).toBe(
          "published",
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
}
