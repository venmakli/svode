import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";

import { mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

// The toasts of the entries are read from a mocked `sonner`, loaded first.
if (process.env.SVODE_SIDEBAR_COMMIT_REFUSAL_DOM !== "1") {
  test("sidebar commit refusal DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SIDEBAR_COMMIT_REFUSAL_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  const toasts: {
    kind: string;
    message: string;
    action?: { label: string; onClick: () => void };
  }[] = [];
  const record =
    (kind: string) =>
    (
      message: string,
      options?: { action?: { label: string; onClick: () => void } },
    ) =>
      toasts.push({ kind, message, action: options?.action });
  mock.module("sonner", () => ({
    toast: Object.assign(record("default"), {
      error: record("error"),
      info: record("info"),
      warning: record("warning"),
      success: record("success"),
    }),
  }));

  const { registerPageSaveOwner } = await import("../editor");
  const { useSpaceSidebarGit } = await import("./use-space-sidebar-git");

  const SPACE = "/df223-space";
  const commits: string[] = [];
  const refusalText =
    "Nothing was committed: the file of “Plan” changed outside Svode and your text isn't written yet. Choose a version, then try again.";

  function setup() {
    toasts.length = 0;
    commits.length = 0;
    mockNativeIpc(
      (command) => {
        if (command === "git_status")
          return { files: [{ path: "board/plan.md", state: "modified" }] };
        if (command.startsWith("git_commit_")) {
          commits.push(command);
          return { files: [] };
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    const state = { conflicted: true, choices: 0 };
    const release = registerPageSaveOwner(SPACE, "board/plan.md", {
      save: async () => null,
      saveAll: async () => null,
      sourceConflict: () =>
        state.conflicted
          ? { title: "Plan", chooseVersion: () => state.choices++ }
          : null,
    });
    return { state, release };
  }

  async function settle() {
    for (let turn = 0; turn < 10; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function expectRefusalToast(state: { choices: number }) {
    expect(toasts.map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: "warning", message: refusalText },
    ]);
    expect(toasts[0].action?.label).toBe("Choose version");
    toasts[0].action!.onClick();
    expect(state.choices).toBe(1);
  }

  test("Save all of the sidebar and Space home commits nothing while a Page holds a source conflict", async () => {
    const dom = await createTestDom();
    const { state, release } = setup();
    let commitAll!: () => void;
    function Row() {
      const git = useSpaceSidebarGit(SPACE, "/df223-project");
      useEffect(() => {
        commitAll = git.commitAll;
      });
      return null;
    }
    try {
      await dom.render(<Row />);
      await act(async () => {
        commitAll();
        await settle();
      });
      expect(commits).toEqual([]);
      expectRefusalToast(state);

      state.conflicted = false;
      await act(async () => {
        commitAll();
        await settle();
      });
      expect(commits).toEqual(["git_commit_all"]);
      expect(toasts.length).toBe(1);
    } finally {
      release();
      // Unmounting unlistens through the mocked IPC of this DOM.
      await dom.dispose();
    }
  });
}
