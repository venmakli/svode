import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { toGitBranchBlockDto } from "@/platform/git/branch-errors";
import { rethrowGitSaveError } from "@/platform/git/save-errors";
import { gitBranchErrorMessage } from "./git-branch-error";
import { gitSaveErrorFromError } from "./git-save-error";
import { gitSaveErrorDescription } from "../ui/git-save-error-copy";
import { selectIndicator, useGitStore } from "../model/git-store";

test("branch blockers survive the save boundary and give the same localized recovery as clone/sync", async () => {
  const original = getLocale();
  try {
    for (const locale of ["en", "ru"] as const) {
      await setLocale(locale, { reload: false });
      for (const reason of [
        "configuration",
        "root_detached",
        "remote_unavailable",
        "missing_branch",
        "local_changes",
        "operation_in_progress",
        "local_history",
        "incompatible_branch",
        "checkout_failed",
      ]) {
        const raw = { kind: "git_branch_blocked", reason, stderr: "SECRET" };
        let safe: unknown;
        try {
          rethrowGitSaveError(raw);
        } catch (error) {
          safe = error;
        }
        expect(safe).toEqual({ kind: "git_branch_blocked", reason });
        const message = gitBranchErrorMessage(safe);
        expect(
          message?.includes(
            locale === "en" ? "then retry" : "повторите действие",
          ),
        ).toBe(true);
        expect(message?.includes("SECRET")).toBe(false);
        expect(gitSaveErrorDescription(gitSaveErrorFromError(safe))).toBe(
          message!,
        );
        expect(gitSaveErrorFromError(safe).outcome).toBe("failed");
      }
    }
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("malformed branch payloads are not trusted or mistaken for access denial", () => {
  for (const raw of [
    null,
    "SECRET",
    { kind: "git_branch_blocked", reason: "SECRET" },
    { kind: "repository_access_denied", reason: "local_changes" },
  ]) {
    expect(toGitBranchBlockDto(raw)).toBeNull();
    expect(gitBranchErrorMessage(raw)).toBeNull();
  }
});

test("branch recovery survives remote-status refresh and remains scoped to its repository", () => {
  const git = useGitStore.getState();
  const path = "/fixture/child";
  git.setBranchError(path, "Local work requires recovery");
  git.setSyncError(path, null);
  git.applyStatus(path, {
    branch: "HEAD",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: false,
    hasConflicts: false,
    tracking: null,
    files: [],
  });
  expect(useGitStore.getState().branchError[path]?.includes("recovery")).toBe(
    true,
  );
  expect(selectIndicator(useGitStore.getState(), path)).toBe("error");
  expect(selectIndicator(useGitStore.getState(), "/fixture/other")).toBe(
    "clean",
  );
  git.clear(path);
  expect(useGitStore.getState().branchError[path] === undefined).toBe(true);
});
