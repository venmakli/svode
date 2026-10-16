import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useContext, useEffect } from "react";
import type { ChatFileChangesTarget } from "@/features/agent-sessions";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_CHAT_CHANGES_WINDOW_TEST !== "1") {
  test("the chat Changes window saves its file with the project of its Space", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CHAT_CHANGES_WINDOW_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const dom = await createTestDom();
  const doc = dom.document;
  const project = "/project";
  const space = "/project/research";
  const spaces = {
    rootSpaces: [{ id: "root", name: "Project", path: project }],
    spaces: [{ id: "research", name: "Research", path: space }],
    fileTrees: {},
    activeRootId: "root",
    activeRootName: "Project",
    activeRootPath: project,
  };
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (selector?: (state: typeof spaces) => unknown) =>
      selector ? selector(spaces) : spaces,
  }));

  const base = {
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: true,
    hasConflicts: false,
    tracking: null,
  };
  // Besides the agent's file each repository has other changed and untracked
  // files, which the save leaves alone.
  const files: Record<string, { path: string; state: string }[]> = {
    [project]: [
      { path: "edit-me.txt", state: "modified" },
      { path: "notes.md", state: "modified" },
      { path: ".DS_Store", state: "untracked" },
      { path: ".svode/order.json", state: "untracked" },
    ],
    [space]: [
      { path: "plan.txt", state: "modified" },
      { path: "draft.md", state: "untracked" },
    ],
  };
  const commits: unknown[] = [];
  const policies: unknown[] = [];
  mockNativeIpc(
    (command, args) => {
      const input = args as {
        spacePath: string;
        filePaths: string[];
        paths: string[];
        generation: string;
      };
      if (command === "git_status")
        return { ...base, files: files[input.spacePath] };
      if (command === "repository_access_get")
        return {
          status: "local",
          repositoryId: input.spacePath,
          generation: 1,
          checkedAt: null,
          expiresAt: null,
          lastKnownStatus: null,
          reason: null,
        };
      if (command === "git_inspection_stats")
        return {
          generation: input.generation,
          items: input.paths.map((path) => ({
            path,
            additions: 1,
            deletions: 1,
          })),
        };
      if (command === "git_working_tree_item")
        return {
          ...input,
          state: "text",
          before: "before\n",
          after: "after\n",
        };
      if (command === "git_commit_paths") {
        commits.push(args);
        files[input.spacePath] = files[input.spacePath]!.filter(
          (file) => !input.filePaths.includes(file.path),
        );
        return { ...base, files: files[input.spacePath] };
      }
      if (command === "git_get_user_policy") {
        policies.push(args);
        return { autoSync: false };
      }
      throw new Error(`Unexpected IPC: ${command}`);
    },
    { shouldMockEvents: true },
  );

  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { ChatChangesOpenerContext } =
    await import("@/features/agent-sessions");
  const { ChatChangesWindowProvider } = await import("./chat-changes-window");

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 5; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const footer = () => doc.querySelector('[data-slot="sheet-footer"]');

  let open: ((target: ChatFileChangesTarget) => void) | null = null;
  function Opener() {
    const opener = useContext(ChatChangesOpenerContext);
    useEffect(() => {
      open = opener;
    });
    return null;
  }

  async function saveFromChat(target: ChatFileChangesTarget) {
    commits.length = 0;
    policies.length = 0;
    await dom.render(
      <ThemeProvider theme="light" setTheme={() => {}}>
        <TooltipProvider>
          <ChatChangesWindowProvider>
            <Opener />
          </ChatChangesWindowProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    await act(async () => open!(target));
    await settle();
    expect(footer()?.querySelector("button")?.disabled).toBe(false);
    await act(async () => {
      footer()!.querySelector("button")!.click();
    });
    await settle();
  }

  test("a project file without an editor commits only itself with its project", async () => {
    await saveFromChat({
      spaceId: "root",
      spacePath: project,
      path: "edit-me.txt",
      name: "edit-me.txt",
    });
    expect(JSON.stringify(commits)).toBe(
      JSON.stringify([
        {
          projectPath: project,
          spacePath: project,
          filePaths: ["edit-me.txt"],
        },
      ]),
    );
    // The window is clean without an error.
    expect(Boolean(doc.querySelector("[data-changes-body]"))).toBe(true);
    expect(footer()).toBeNull();
    expect(Boolean(doc.querySelector('[role="alert"]'))).toBe(false);
    expect(files[project]!.map((file) => file.path).includes("notes.md")).toBe(
      true,
    );
    await dom.render(null);
  });

  test("a Submodule Space file commits in its Space with the project", async () => {
    await saveFromChat({
      spaceId: "research",
      spacePath: space,
      path: "plan.txt",
      name: "plan.txt",
    });
    expect(JSON.stringify(commits)).toBe(
      JSON.stringify([
        { projectPath: project, spacePath: space, filePaths: ["plan.txt"] },
      ]),
    );
    // Auto-sync policy is resolved with the project too.
    expect(JSON.stringify(policies)).toBe(
      JSON.stringify([{ spacePath: space, projectPath: project }]),
    );
    expect(footer()).toBeNull();
    expect(Boolean(doc.querySelector('[role="alert"]'))).toBe(false);
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  });
}
