import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";

import { mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

// The toasts of the entries are read from a mocked `sonner`, loaded first.
if (process.env.SVODE_COLLECTION_COMMIT_REFUSAL_DOM !== "1") {
  test("collection commit refusal DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_COMMIT_REFUSAL_DOM: "1" },
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

  const { registerPageSaveOwner } = await import("@/features/git/editor");
  const { useCollectionSaveShortcuts } =
    await import("./use-collection-save-shortcuts");

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

  test("⇧⌘S of the collection screen commits nothing while a Page of the collection holds a source conflict", async () => {
    const dom = await createTestDom();
    const { state, release } = setup();
    function Collection() {
      useCollectionSaveShortcuts({
        readOnly: false,
        readmePath: "board/README.md",
        saveScopeTree: [{ path: "board/README.md", has_schema: true }],
        spacePath: SPACE,
      });
      return null;
    }
    const saveAll = () =>
      act(async () => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "s",
            metaKey: true,
            shiftKey: true,
            cancelable: true,
          }),
        );
        await settle();
      });
    try {
      await dom.render(<Collection />);
      await saveAll();
      expect(commits).toEqual([]);
      expectRefusalToast(state);

      state.conflicted = false;
      await saveAll();
      expect(commits).toEqual(["git_commit_paths"]);
      expect(toasts.length).toBe(1);
    } finally {
      release();
      // Unmounting unlistens through the mocked IPC of this DOM.
      await dom.dispose();
    }
  });
}
