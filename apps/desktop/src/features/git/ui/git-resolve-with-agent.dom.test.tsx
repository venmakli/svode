import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { AgentRequest } from "../model/agent-request";

if (process.env.SVODE_RESOLVE_WITH_AGENT_DOM !== "1") {
  test("Git sync Dialog resolves conflicts with an agent", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_RESOLVE_WITH_AGENT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const space = {
    activeRootPath: "/project",
    rootSpaces: [],
    spaces: [
      { id: "space", path: "/project/space", name: "Space" },
      { id: "inline", path: "/project/inline", name: "Inline" },
    ],
    fileTrees: {
      space: [{ path: "Onboarding.md", title: "Onboarding", children: [] }],
    },
  };
  mock.module("@/features/space", () => ({
    selectActiveSpacePath: () => "/project/space",
    useSpace: (select: (value: typeof space) => unknown) => select(space),
  }));

  const RULES = "Git in a Svode project:\n- Svode rules.";
  let path = "/project/space";
  let repository: string | undefined;
  let preflight: unknown = null;
  let syncReport: unknown = null;
  const commands: string[] = [];
  const events: string[] = [];

  function mockGit() {
    commands.length = 0;
    events.length = 0;
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
        if (command === "git_last_synced") return null;
        if (command === "git_sync_preflight") return preflight;
        if (command === "git_sync") {
          events.push("sync");
          return syncReport;
        }
        if (command === "git_agent_rules") return RULES;
        if (command === "git_fetch_status" || command === "git_status")
          return { repository, branch: "main", ahead: 1, behind: 2, files: [] };
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

  async function harness(available: boolean | null) {
    const dom = await createTestDom();
    mockGit();
    const { useGitStore } = await import("../model/git-store");
    const { GitSyncStatusWidget } = await import("./git-sync-status-widget");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { registerAgentRequests } = await import("../model/agent-request");
    const m = await import("@/paraglide/messages.js");
    const submitted: AgentRequest[] = [];
    const places: string[] = [];
    const unregister =
      available === null
        ? () => {}
        : registerAgentRequests({
            available: async ({ spacePath }) => {
              places.push(spacePath);
              return available;
            },
            submit: async (request) => {
              events.push("submit");
              submitted.push(request);
              return true;
            },
          });
    await dom.render(
      <TooltipProvider>
        <GitSyncStatusWidget repositoryPath={path} onOpenPage={() => {}} />
      </TooltipProvider>,
    );
    await settle();
    const openDialog = async () => {
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>("[data-repository-control]")!
          .click();
      });
      await settle();
      return dom.document.querySelector<HTMLElement>("[role=dialog]")!;
    };
    const dispose = async () => {
      unregister();
      useGitStore.getState().clear(path);
      if (repository) useGitStore.getState().clear(repository);
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    };
    return { dom, m, useGitStore, submitted, places, openDialog, dispose };
  }

  const footerButtons = (dialog: HTMLElement) =>
    Array.from(
      dialog.querySelectorAll<HTMLButtonElement>(
        "[data-slot=dialog-footer] button",
      ),
    );

  test("a merge stop hands its unresolved paths, names, kinds and the rules to a new chat session, marked", async () => {
    path = "/project/space";
    repository = undefined;
    preflight = {
      type: "conflict",
      files: ["Onboarding.md", ".svode/order.json", "a.md", "b.md", "data.bin"],
      kinds: [
        { path: "Onboarding.md", kind: "page_text" },
        { path: ".svode/order.json", kind: "text" },
        { path: "b.md", kind: "rename_rename", also: ["a.md"] },
        { path: "data.bin", kind: "binary" },
      ],
      service: [{ path: ".svode/order.json", state: "mergeable" }],
    };
    const { m, submitted, places, openDialog, dispose, dom } =
      await harness(true);
    try {
      const dialog = await openDialog();
      const buttons = footerButtons(dialog);
      const agent = dialog.querySelector<HTMLButtonElement>(
        "[data-git-resolve-with-agent]",
      )!;
      // Next to «Отменить синхронизацию», as a secondary action.
      expect(buttons.map((button) => button.textContent)).toEqual([
        m.git_resolve_with_agent(),
        m.git_sync_abort_action(),
      ]);
      expect(agent.dataset.variant).toBe("outline");
      expect(agent.disabled).toBe(false);
      expect(places.at(-1)).toBe("/project/space");

      await act(async () => {
        agent.click();
      });
      await settle();
      expect(submitted.length).toBe(1);
      const [request] = submitted;
      expect(request.spacePath).toBe("/project/space");
      expect(request.sessionId).toBe(undefined);
      expect(request.mark).toBe("agent_commits");
      expect(request.text.split("\n")).toEqual([
        m.agent_conflict_request_merge({ path: "/project/space" }),
        "",
        m.agent_conflict_request_files(),
        `- Onboarding: \`Onboarding.md\` (${m.git_conflict_kind_page_text()})`,
        `- \`b.md\`, \`a.md\` (${m.git_conflict_kind_rename_rename()})`,
        `- \`data.bin\` (${m.git_conflict_kind_binary()})`,
        "",
        "Git in a Svode project:",
        "- Svode rules.",
      ]);
      // The Dialog closes for the composer; nothing is sent or synced.
      expect(dom.document.querySelector("[role=dialog]")).toBe(null);
      expect(events).toEqual(["submit"]);
      expect(
        commands.some(
          (command) =>
            command.startsWith("agent_runtime_") || command === "git_sync",
        ),
      ).toBe(false);
    } finally {
      await dispose();
    }
  });

  test("files in conflict without an operation are handed over as such, in the project root of an Inline Space", async () => {
    path = "/project/inline";
    repository = "/project";
    preflight = {
      type: "unmergedFiles",
      files: ["inline/notes.txt"],
      kinds: [{ path: "inline/notes.txt", kind: "text" }],
    };
    const { m, submitted, places, openDialog, dispose } = await harness(true);
    try {
      const dialog = await openDialog();
      expect(!!dialog.querySelector("[data-git-sync-stop=unmerged]")).toBe(
        true,
      );
      // No cancellation here: the action stands alone.
      expect(footerButtons(dialog).map((button) => button.textContent)).toEqual(
        [m.git_resolve_with_agent()],
      );
      // The session runs in the repository: the project root.
      expect(places.at(-1)).toBe("/project");
      await act(async () => {
        dialog
          .querySelector<HTMLButtonElement>("[data-git-resolve-with-agent]")!
          .click();
      });
      await settle();
      expect(submitted.map((request) => request.spacePath)).toEqual([
        "/project",
      ]);
      expect(submitted[0].mark).toBe("agent_commits");
      expect(submitted[0].text.split("\n").slice(0, 4)).toEqual([
        m.agent_conflict_request_unmerged({ path: "/project" }),
        "",
        m.agent_conflict_request_files(),
        `- \`inline/notes.txt\` (${m.git_conflict_kind_text()})`,
      ]);
    } finally {
      await dispose();
    }
  });

  test("from «Конфликт с правками коллег» the merge state comes first, then the session with the paths it left", async () => {
    path = "/project/space";
    repository = undefined;
    preflight = null;
    const { m, useGitStore, submitted, openDialog, dispose } =
      await harness(true);
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    try {
      recordGitOperationOutcome({
        repository: path,
        active: false,
        report: {
          type: "incomingConflict",
          files: [
            { path: "Onboarding.md", kind: "page_text" },
            { path: "notes.txt", kind: "text" },
          ],
        },
        error: null,
      });
      const dialog = await openDialog();
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("incoming");
      // Next to «Синхронизировать и разрешить», the primary action.
      expect(footerButtons(dialog).map((button) => button.textContent)).toEqual(
        [m.git_resolve_with_agent(), m.git_sync_stop_incoming_action()],
      );

      // The explicit sync merges; Svode merged the order and one path
      // resolved cleanly, so only the Page is left.
      syncReport = {
        type: "conflict",
        files: ["Onboarding.md"],
        kinds: [{ path: "Onboarding.md", kind: "page_text" }],
        merged: [".svode/order.json"],
      };
      await act(async () => {
        dialog
          .querySelector<HTMLButtonElement>("[data-git-resolve-with-agent]")!
          .click();
      });
      await settle();
      expect(events).toEqual(["sync", "submit"]);
      expect(useGitStore.getState().syncStop[path]?.kind).toBe("conflict");
      expect(submitted[0].mark).toBe("agent_commits");
      expect(submitted[0].text.split("\n").slice(0, 5)).toEqual([
        m.agent_conflict_request_merge({ path }),
        "",
        m.agent_conflict_request_files(),
        `- Onboarding: \`Onboarding.md\` (${m.git_conflict_kind_page_text()})`,
        "",
      ]);
    } finally {
      await dispose();
    }
  });

  test("an explicit sync that leaves no conflict opens no session", async () => {
    path = "/project/space";
    repository = undefined;
    preflight = null;
    const { submitted, openDialog, dispose } = await harness(true);
    const { recordGitOperationOutcome } =
      await import("../api/git-operation-events");
    try {
      recordGitOperationOutcome({
        repository: path,
        active: false,
        report: {
          type: "incomingConflict",
          files: [{ path: "notes.txt", kind: "text" }],
        },
        error: null,
      });
      const dialog = await openDialog();
      syncReport = { type: "success" };
      await act(async () => {
        dialog
          .querySelector<HTMLButtonElement>("[data-git-resolve-with-agent]")!
          .click();
      });
      await settle();
      expect(events).toEqual(["sync"]);
      expect(submitted).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("without a chat session the action is unavailable and says why", async () => {
    for (const available of [false, null] as const) {
      path = "/project/space";
      repository = undefined;
      preflight = {
        type: "conflict",
        files: ["notes.txt"],
        kinds: [{ path: "notes.txt", kind: "text" }],
      };
      const { m, submitted, openDialog, dispose } = await harness(available);
      try {
        const dialog = await openDialog();
        const agent = dialog.querySelector<HTMLButtonElement>(
          "[data-git-resolve-with-agent]",
        )!;
        expect(agent.disabled).toBe(true);
        const reason = dialog.querySelector<HTMLElement>(
          "[data-git-resolve-with-agent-reason]",
        )!;
        expect(reason.getAttribute("aria-label")).toBe(
          `${m.git_resolve_with_agent()}. ${m.git_resolve_with_agent_unavailable()}`,
        );
        expect(submitted).toEqual([]);
      } finally {
        await dispose();
      }
    }
  });

  test("other stops do not offer it, nor a merge left only with Svode service files", async () => {
    for (const stop of [
      { type: "operationInProgress", operation: "rebase" },
      {
        type: "conflict",
        files: [".svode/order.json"],
        kinds: [{ path: ".svode/order.json", kind: "text" }],
        service: [{ path: ".svode/order.json", state: "mergeable" }],
      },
    ]) {
      path = "/project/space";
      repository = undefined;
      preflight = stop;
      const { openDialog, dispose } = await harness(true);
      try {
        const dialog = await openDialog();
        expect(!!dialog.querySelector("[data-git-sync-stop]")).toBe(true);
        expect(dialog.querySelector("[data-git-resolve-with-agent]")).toBe(
          null,
        );
      } finally {
        await dispose();
      }
    }
  });
}
