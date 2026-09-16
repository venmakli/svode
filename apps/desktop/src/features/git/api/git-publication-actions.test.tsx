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
} from "./git-actions";
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
