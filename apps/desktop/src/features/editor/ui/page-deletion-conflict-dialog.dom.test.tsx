import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

if (process.env.SVODE_PAGE_DELETION_CONFLICT_DOM !== "1") {
  test("an open Page in a modify/delete conflict asks to keep or delete it", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PAGE_DELETION_CONFLICT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
  }, 30000);
} else {
  const toasts: { kind: string; message: unknown }[] = [];
  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toasts.push({ kind: "error", message }),
      info: (message: unknown) => toasts.push({ kind: "info", message }),
      warning: (message: unknown) => toasts.push({ kind: "warning", message }),
    },
  }));
  // Known as this Desktop's deletion, the open Page closes as one deleted here.
  const tracked: { spacePath: string; path: string }[] = [];
  const pageApi = await import("@/features/page/page-api");
  mock.module("@/features/page/page-api", () => ({
    ...pageApi,
    trackOwnContentDeletion: async (
      target: { spacePath: string; path: string },
      run: () => Promise<unknown>,
    ) => {
      const result = await run();
      tracked.push(target);
      return result;
    },
  }));

  const spacePath = "/project/space";
  const path = "notes/plan.md";
  type Side = "modified" | "deleted";
  const side = (change: Side) => ({ change, path: null, size: null });

  function status(conflicts: string[]) {
    return {
      branch: "main",
      ahead: 0,
      behind: 0,
      hasStaged: true,
      hasUnstaged: false,
      hasConflicts: conflicts.length > 0,
      tracking: "origin/main",
      files: conflicts.map((file) => ({
        path: file,
        state: "conflict" as const,
      })),
      totalFiles: conflicts.length,
      omittedFiles: 0,
    };
  }

  async function setup({
    kind = "modify_delete",
    deletedBy = "theirs",
    resolve = () => ({ type: "resolved" }),
  }: {
    kind?: string;
    deletedBy?: "ours" | "theirs";
    resolve?: () => unknown;
  } = {}) {
    const dom = await createTestDom();
    const calls: string[] = [];
    const resolutions: unknown[] = [];
    let finishResolution: (() => void) | null = null;
    let holdResolution = false;
    mockNativeIpc(
      async (command, args) => {
        if (command === "git_conflict_kinds") return [{ path, kind }];
        if (command === "git_conflict_file")
          return {
            path,
            kind,
            version: "v1",
            content: null,
            places: null,
            ours: deletedBy === "theirs",
            theirs: deletedBy === "ours",
            binary: false,
            changes:
              deletedBy === "theirs"
                ? { ours: side("modified"), theirs: side("deleted") }
                : { ours: side("deleted"), theirs: side("modified") },
          };
        if (command === "git_resolve_conflict_file") {
          calls.push("resolve");
          resolutions.push((args as { resolution: unknown }).resolution);
          if (holdResolution)
            await new Promise<void>((done) => (finishResolution = done));
          return resolve();
        }
        if (command === "git_status") return status([]);
        throw new Error(command);
      },
      { shouldMockEvents: true },
    );
    const { useGitStore } = await import("@/features/git");
    const { PageDeletionConflictDialog } =
      await import("./page-deletion-conflict-dialog");
    const m = await import("@/paraglide/messages.js");
    useGitStore.getState().applyStatus(spacePath, status([path]));
    let saved = true;
    const settlePendingSource = async () => {
      calls.push("save");
      return saved;
    };
    const settle = () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, 30));
      });
    const dialog = () => dom.document.querySelector("[role=alertdialog]");
    const button = (text: string) =>
      Array.from(dialog()?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent === text,
      ) as HTMLButtonElement | undefined;
    const click = (text: string) =>
      act(async () => {
        button(text)!.click();
        await new Promise((done) => setTimeout(done, 30));
      });
    const render = async (key = "open", enabled = true) => {
      await dom.render(
        <PageDeletionConflictDialog
          key={key}
          spacePath={spacePath}
          path={path}
          title="Plan"
          enabled={enabled}
          settlePendingSource={settlePendingSource}
        />,
      );
      await settle();
    };
    toasts.length = 0;
    tracked.length = 0;
    return {
      dom,
      m,
      calls,
      resolutions,
      dialog,
      button,
      click,
      render,
      settle,
      useGitStore,
      unsaved: () => {
        saved = false;
      },
      hold: () => {
        holdResolution = true;
      },
      release: () =>
        act(async () => {
          finishResolution?.();
          await new Promise((done) => setTimeout(done, 30));
        }),
      async dispose() {
        await dom.render(null);
        useGitStore.getState().clear(spacePath);
        clearNativeMocks();
        await dom.dispose();
      },
    };
  }

  test("edited here and deleted by a colleague: «Оставить с правками» writes the draft, then keeps my version", async () => {
    const t = await setup();
    try {
      await t.render();
      expect(t.dialog()?.textContent).toContain(
        t.m.page_deletion_conflict_theirs_deleted_title({ title: "Plan" }),
      );
      expect(t.dialog()?.textContent).toContain(
        t.m.page_deletion_conflict_theirs_deleted_description(),
      );
      // Left to right: «Позже», «Удалить», «Оставить с правками».
      expect(
        Array.from(t.dialog()!.querySelectorAll("button")).map(
          (button) => button.textContent,
        ),
      ).toEqual([
        t.m.page_deletion_conflict_later(),
        t.m.changes_conflict_delete(),
        t.m.changes_conflict_keep_edited(),
      ]);
      await t.click(t.m.changes_conflict_keep_edited());
      expect(t.calls).toEqual(["save", "resolve"]);
      expect(t.resolutions).toEqual([{ type: "side", side: "ours" }]);
      expect(tracked).toEqual([]);
      expect(t.dialog()).toBe(null);
    } finally {
      await t.dispose();
    }
  });

  test("deleted here and edited by a colleague: «Удалить» writes the draft and deletes the Page as this Desktop's deletion", async () => {
    const t = await setup({ deletedBy: "ours" });
    try {
      await t.render();
      expect(t.dialog()?.textContent).toContain(
        t.m.page_deletion_conflict_ours_deleted_title({ title: "Plan" }),
      );
      expect(t.dialog()?.textContent).toContain(
        t.m.page_deletion_conflict_ours_deleted_description(),
      );
      await t.click(t.m.changes_conflict_delete());
      expect(t.calls).toEqual(["save", "resolve"]);
      expect(t.resolutions).toEqual([{ type: "delete" }]);
      expect(tracked).toEqual([{ spacePath, path }]);
      expect(t.dialog()).toBe(null);
    } finally {
      await t.dispose();
    }
  });

  test("«Оставить с правками» of a colleague's edit keeps their version", async () => {
    const t = await setup({ deletedBy: "ours" });
    try {
      await t.render();
      await t.click(t.m.changes_conflict_keep_edited());
      expect(t.resolutions).toEqual([{ type: "side", side: "theirs" }]);
    } finally {
      await t.dispose();
    }
  });

  test("«Позже» and Esc close without a resolution; the next opening asks again", async () => {
    const t = await setup();
    try {
      await t.render("first");
      await t.click(t.m.page_deletion_conflict_later());
      expect(t.dialog()).toBe(null);
      await t.render("second");
      expect(t.dialog()).not.toBe(null);
      await act(async () => {
        t.dialog()!.dispatchEvent(
          new t.dom.document.defaultView!.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
        await new Promise((done) => setTimeout(done, 30));
      });
      expect(t.dialog()).toBe(null);
      expect(t.calls).toEqual([]);
      await t.render("third");
      expect(t.dialog()).not.toBe(null);
    } finally {
      await t.dispose();
    }
  });

  test("an open Page that comes into the conflict asks; its end closes the question", async () => {
    const t = await setup();
    try {
      t.useGitStore.getState().applyStatus(spacePath, status([]));
      await t.render();
      expect(t.dialog()).toBe(null);
      await act(async () => {
        t.useGitStore.getState().applyStatus(spacePath, status([path]));
        await new Promise((done) => setTimeout(done, 30));
      });
      expect(t.dialog()).not.toBe(null);
      // "Позже", then the path leaves the conflict and comes into a new one.
      await t.click(t.m.page_deletion_conflict_later());
      await act(async () => {
        t.useGitStore.getState().applyStatus(spacePath, status([]));
        await new Promise((done) => setTimeout(done, 30));
      });
      await act(async () => {
        t.useGitStore.getState().applyStatus(spacePath, status([path]));
        await new Promise((done) => setTimeout(done, 30));
      });
      expect(t.dialog()).not.toBe(null);
    } finally {
      await t.dispose();
    }
  });

  test("other kinds, no conflict and a read-only Page show no question", async () => {
    for (const kind of ["page_text", "page_properties", "add_add"]) {
      const t = await setup({ kind });
      try {
        await t.render();
        expect(t.dialog()).toBe(null);
      } finally {
        await t.dispose();
      }
    }
    const clean = await setup();
    try {
      clean.useGitStore.getState().applyStatus(spacePath, status([]));
      await clean.render();
      expect(clean.dialog()).toBe(null);
    } finally {
      await clean.dispose();
    }
    const readOnly = await setup();
    try {
      await readOnly.render("open", false);
      expect(readOnly.dialog()).toBe(null);
    } finally {
      await readOnly.dispose();
    }
  });

  test("the choices wait while one runs; a refusal is named and the path stays", async () => {
    const t = await setup({
      resolve: () => ({
        type: "unresolved",
        path,
        finding: { type: "markers" },
      }),
    });
    try {
      t.hold();
      await t.render();
      await t.click(t.m.changes_conflict_keep_edited());
      for (const text of [
        t.m.page_deletion_conflict_later(),
        t.m.changes_conflict_delete(),
        t.m.changes_conflict_keep_edited(),
      ])
        expect(t.button(text)?.disabled).toBe(true);
      await t.release();
      expect(t.dialog()).toBe(null);
      expect(toasts).toEqual([
        {
          kind: "error",
          message: t.m.git_resolve_page_failed({ page: "Plan" }),
        },
      ]);
      expect(
        t.useGitStore
          .getState()
          .statuses[spacePath]?.files.map((file) => file.path),
      ).toEqual([path]);
    } finally {
      await t.dispose();
    }
  });

  test("a draft that stays unsaved stops the choice", async () => {
    const t = await setup();
    try {
      t.unsaved();
      await t.render();
      await t.click(t.m.changes_conflict_delete());
      expect(t.calls).toEqual(["save"]);
      expect(toasts).toEqual([
        { kind: "error", message: t.m.page_surface_save_error() },
      ]);
      expect(tracked).toEqual([]);
      expect(t.dialog()).toBe(null);
    } finally {
      await t.dispose();
    }
  });
}
