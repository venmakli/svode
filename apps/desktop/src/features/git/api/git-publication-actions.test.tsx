import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { mockNativeIpc, clearNativeMocks } from "@/platform/native/testing";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { useGitStore } from "../model/git-store";
import { parentRecoveryAction, isFullSyncSuccess } from "../model/publication";
import { GitPublicationResult } from "../ui/git-publication-result";
import { publicationCopy } from "../ui/git-publication-copy";
import {
  recordSyncPublication,
  refreshGitPublication,
  retryParentPublication,
} from "./git-publication-actions";
import {
  commitFileAndMaybeSync,
  commitAllSpace,
  commitPathsAndMaybeSync,
  syncOnOpen,
  continueGitResolve,
  syncSpace,
} from "./git-actions";
import { refreshGitRemoteStatus } from "./git-status-actions";
import { gitSyncErrorMessage } from "./git-sync-error";
import { toParentPublication } from "./git-mappers";
import type { GitPublicationStatus, ParentPublication } from "../model/types";

if (process.env.SVODE_PUBLICATION_TEST !== "1") {
  test("publication state, recovery and localized surface scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PUBLICATION_TEST: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  });
} else {
  const dom = new JSDOM("<!doctype html>");
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  const path = "/project/child";
  const publication: GitPublicationStatus = {
    childHead: "sha",
    child: "published",
    parent: { repository: "/project", pointer: "pending", target: "target" },
  };
  const status = {
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: false,
    hasConflicts: false,
    tracking: "origin/main",
    files: [],
  };

  test("sync cause survives successful and failed counter refreshes", async () => {
    let failFetch = false;
    let fetches = 0;
    mockNativeIpc(async (command) => {
      if (command === "git_sync")
        throw {
          kind: "git_publication_blocked",
          reason: "revision_unavailable",
          child: "develop",
        };
      if (command === "git_fetch_status") {
        fetches++;
        if (failFetch) throw "git fetch failed: connection timed out";
        return status;
      }
      throw new Error(command);
    });
    try {
      const outcome = await syncSpace(path);
      expect(outcome.type).toBe("Failed");
      const cause = useGitStore.getState().syncError[path];
      expect(cause.includes("develop")).toBe(true);
      expect(cause.includes("[object Object]")).toBe(false);
      await Promise.all([
        refreshGitRemoteStatus(path),
        refreshGitRemoteStatus(path),
      ]);
      expect(fetches).toBe(1);
      expect(useGitStore.getState().syncError[path]).toBe(cause);
      failFetch = true;
      await refreshGitRemoteStatus(path).catch(() => {});
      expect(useGitStore.getState().syncError[path]).toBe(cause);
      expect(
        useGitStore
          .getState()
          .remoteError[path].includes("connection timed out"),
      ).toBe(true);
      failFetch = false;
      await refreshGitRemoteStatus(path);
      expect(useGitStore.getState().remoteError[path] === undefined).toBe(true);
      expect(useGitStore.getState().syncError[path]).toBe(cause);
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(path);
    }
  });

  test("overlapping sync triggers share a flight and a later save is still published", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let syncCalls = 0;
    mockNativeIpc(async (command) => {
      if (command === "git_sync") {
        syncCalls++;
        if (syncCalls === 1) {
          started();
          await pending;
        }
        return { type: "success", publishedHead: String(syncCalls) };
      }
      if (command === "git_status" || command === "git_commit_file")
        return status;
      if (command === "git_get_user_policy") return { autoSync: true };
      throw new Error(command);
    });
    try {
      const first = syncSpace(path, true);
      await entered;
      const second = syncSpace(path, true);
      expect(first).toBe(second);
      await commitFileAndMaybeSync(path, "README.md");
      expect(syncCalls).toBe(1);
      expect(useGitStore.getState().syncing[path]).toBe(true);
      release();
      await first;
      expect(syncCalls).toBe(2);
      expect(useGitStore.getState().syncing[path] === undefined).toBe(true);
    } finally {
      release();
      clearNativeMocks();
      useGitStore.getState().clear(path);
    }
  });

  test("opening the project waits for a running child publication", async () => {
    for (const rootPath of ["/project", "C:\\project"]) {
      const childPath = `${rootPath}${rootPath.includes("\\") ? "\\" : "/"}child`;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      mockNativeIpc(async (command, args) => {
        if (command === "git_get_user_policy") return { autoSync: true };
        if (command === "git_status") return status;
        if (command === "git_sync") {
          const target = String((args as { spacePath: string }).spacePath);
          calls.push(target);
          if (target === childPath) {
            started();
            await pending;
          }
          return { type: "success", publishedHead: "published" };
        }
        throw new Error(command);
      });
      try {
        const child = syncSpace(childPath, true);
        await entered;
        const parent = syncOnOpen(rootPath, rootPath);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual([childPath]);
        release();
        await Promise.all([child, parent]);
        expect(calls).toEqual([childPath, rootPath]);
      } finally {
        release();
        clearNativeMocks();
        useGitStore.getState().clear(childPath);
        useGitStore.getState().clear(rootPath);
      }
    }
  });

  test("publication reasons and parent Git stderr remain readable in both locales", async () => {
    const locale = getLocale();
    try {
      for (const language of ["en", "ru"] as const) {
        await setLocale(language, { reload: false });
        const reasons = new Set<string>();
        for (const reason of [
          "configuration",
          "uninitialized_child",
          "source_unavailable",
          "revision_unavailable",
          "target_changed",
        ]) {
          const copy = gitSyncErrorMessage({
            kind: "git_publication_blocked",
            reason,
            child: "develop",
            stderr: "SECRET",
          });
          expect(copy.includes("develop")).toBe(true);
          expect(copy.includes("SECRET")).toBe(false);
          reasons.add(copy);
        }
        expect(reasons.size).toBe(5);
        const parent = toParentPublication({
          repository: "/project",
          pointer: "local",
          error:
            "git push failed: https://user:SECRET@example.test/repo rejected by hook",
        });
        const copy = publicationCopy({ ...publication, parent });
        expect(copy.reason?.includes("rejected by hook")).toBe(true);
        expect(copy.reason?.includes("SECRET")).toBe(false);
      }
    } finally {
      await setLocale(locale, { reload: false });
    }
  });

  test("file/all/paths save succeeds with denied parent and does not claim publication", async () => {
    const calls: string[] = [];
    mockNativeIpc((command) => {
      calls.push(command);
      if (command === "git_get_user_policy") return { autoSync: false };
      if (command.startsWith("git_commit_"))
        return {
          ...status,
          parent: {
            ...publication.parent,
            error: { kind: "repository_access_denied", status: "read_only" },
          },
        };
      throw new Error(command);
    });
    try {
      for (const run of [
        () => commitFileAndMaybeSync(path, "note", "/project"),
        () => commitAllSpace(path, "/project"),
        () => commitPathsAndMaybeSync(path, ["note"], "/project"),
      ]) {
        await run();
        const value = useGitStore.getState().publications[path]!;
        expect(value.child).toBe("local");
        expect(value.parent.error?.status).toBe("read_only");
        expect(parentRecoveryAction(value)).toBe("sync");
      }
      expect(
        calls.some((c) => c === "git_sync" || c === "repository_access_verify"),
      ).toBe(false);
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(path);
    }
  });

  test("parent-only retry sends current target without child save or push", async () => {
    useGitStore.getState().setPublication(path, publication);
    mockNativeIpc((command, args) => {
      expect(command).toBe("git_retry_parent");
      expect(args).toEqual({
        spacePath: path,
        expectedHead: "sha",
        expectedParent: "/project",
        expectedTarget: "target",
      });
      return {
        ...publication,
        parent: { ...publication.parent, pointer: "published" },
      };
    });
    try {
      await retryParentPublication(path);
      expect(useGitStore.getState().publications[path]?.parent.pointer).toBe(
        "published",
      );
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(path);
    }
  });

  test("late inspection cannot erase a newer outcome or affect another Space", async () => {
    let finish!: (result: unknown) => void;
    mockNativeIpc(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = refreshGitPublication(path);
      await Promise.resolve();
      recordSyncPublication(path, {
        type: "Success",
        publishedHead: "new-sha",
        parent: publication.parent,
      });
      finish({ ...publication, childHead: "old-sha" });
      await pending;
      expect(useGitStore.getState().publications[path]?.childHead).toBe(
        "new-sha",
      );
      expect(useGitStore.getState().publications["/other"] === undefined).toBe(
        true,
      );
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(path);
    }
  });

  test("on-open and conflict continuation retain typed parent failures", async () => {
    mockNativeIpc((command) => {
      if (command === "git_get_user_policy") return { autoSync: true };
      if (command === "git_status") return status;
      if (command === "git_sync" || command === "git_resolve_continue")
        return {
          type: "success",
          publishedHead: "sha",
          parent: {
            ...publication.parent,
            result: { type: "conflict", files: ["README.md"] },
          },
        };
      throw new Error(command);
    });
    try {
      await syncOnOpen(path);
      expect(
        useGitStore.getState().publications[path]?.parent.result?.type,
      ).toBe("Conflict");
      useGitStore.getState().clear(path);
      await continueGitResolve(path);
      expect(
        useGitStore.getState().publications[path]?.parent.result?.type,
      ).toBe("Conflict");
    } finally {
      clearNativeMocks();
      useGitStore.getState().clear(path);
    }
  });

  test("full/partial/access/auth/conflict actions and RU/EN surface", async () => {
    const original = getLocale();
    try {
      expect(
        isFullSyncSuccess({ type: "Success", parent: publication.parent }),
      ).toBe(false);
      expect(
        isFullSyncSuccess({
          type: "Success",
          parent: { ...publication.parent, pointer: "published" },
        }),
      ).toBe(true);
      expect(isFullSyncSuccess({ type: "Failed", message: "error" })).toBe(
        false,
      );
      const cases: [ParentPublication, string][] = [
        [
          {
            ...publication.parent,
            error: { kind: "repository_access_denied", status: "read_only" },
          },
          "none",
        ],
        [
          {
            ...publication.parent,
            error: { kind: "repository_access_denied", status: "unknown" },
          },
          "verify",
        ],
        [
          {
            ...publication.parent,
            result: { type: "AuthRequired", challenge: null },
          },
          "authenticate",
        ],
        [
          {
            ...publication.parent,
            result: { type: "Conflict", files: ["note"] },
          },
          "resolve",
        ],
        [{ ...publication.parent, policySkipped: true }, "retry"],
      ];
      for (const locale of ["en", "ru"] as const) {
        await setLocale(locale, { reload: false });
        for (const [parent, action] of cases) {
          const value = { ...publication, parent };
          expect(parentRecoveryAction(value)).toBe(action);
          const html = renderToStaticMarkup(
            <GitPublicationResult publication={value} error={null} />,
          );
          const copy = publicationCopy(value);
          expect(html.includes(copy.summary)).toBe(true);
          expect(html.includes(copy.child)).toBe(true);
          expect(html.includes("/project")).toBe(true);
          expect(copy.reason !== null).toBe(true);
          expect(
            publicationCopy({ ...value, child: "local" }).summary !==
              copy.summary,
          ).toBe(true);
        }
      }
    } finally {
      await setLocale(original, { reload: false });
    }
  });
}
