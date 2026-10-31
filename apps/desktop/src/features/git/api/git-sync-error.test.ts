import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { gitSyncErrorMessage } from "./git-sync-error";

const missingObjects = (lfsDeclaration: string | null) => ({
  kind: "git_push_rejected",
  reason: "lfs_objects_missing",
  objectCount: 3,
  lfsDeclaration,
});

test("typed push rejections give one localized cause and one recovery", async () => {
  const original = getLocale();
  try {
    await setLocale("en", { reload: false });
    const cause =
      "The Git provider rejected the push: LFS objects referenced by the commits are missing there (3).";
    for (const [state, action] of [
      [null, "Make sure these objects are uploaded"],
      ["missing", "Update the LFS policy in Settings → Storage"],
      ["pending", "Save .lfsconfig, then sync again."],
      ["foreign", "Remove your own lfs.url from .lfsconfig"],
      ["published", "Svode cannot fix this automatically."],
    ] as const) {
      const message = gitSyncErrorMessage(missingObjects(state));
      expect(message.startsWith(cause)).toBe(true);
      expect(message.includes(action)).toBe(true);
    }
    expect(gitSyncErrorMessage(missingObjects(null)).includes("S3")).toBe(
      false,
    );
    expect(
      gitSyncErrorMessage({
        kind: "git_push_rejected",
        reason: "lfs_transfer_unconfigured",
      }),
    ).toBe(
      "The push stopped: S3 transfer for LFS files is not set up on this device. Set up S3 in Settings → Storage for this space, then sync again.",
    );

    await setLocale("ru", { reload: false });
    expect(gitSyncErrorMessage(missingObjects("pending"))).toBe(
      "Git-провайдер отклонил push: у него нет LFS-объектов, на которые ссылаются коммиты (3). Сохраните .lfsconfig, затем повторите синхронизацию.",
    );
    expect(
      gitSyncErrorMessage({
        kind: "git_push_rejected",
        reason: "lfs_transfer_unconfigured",
      }).startsWith(
        "Push остановлен: на этом устройстве не настроена передача LFS-файлов в S3.",
      ),
    ).toBe(true);
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("unknown push failures keep the existing redacted text", async () => {
  const original = getLocale();
  try {
    await setLocale("en", { reload: false });
    expect(
      gitSyncErrorMessage({
        kind: "git_push_rejected",
        reason: "future_reason",
      }),
    ).toBe("Failed to sync");
    expect(
      gitSyncErrorMessage(
        "Git command failed: git push failed: https://user:secret@example.test/repo.git declined",
      ).includes("secret"),
    ).toBe(false);
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("a pull blocked by local files names every file and the recovery", async () => {
  const original = getLocale();
  const blocked = {
    kind: "git_pull_blocked",
    repository: "/project/space",
    files: [".gitattributes", ".gitignore", "docs/План.md"],
  };
  try {
    await setLocale("ru", { reload: false });
    expect(gitSyncErrorMessage(blocked)).toBe(
      "Входящие изменения затрагивают файлы с несохранёнными правками: .gitattributes, .gitignore, docs/План.md. Сохраните или отмените эти правки и повторите синхронизацию.",
    );
    await setLocale("en", { reload: false });
    expect(gitSyncErrorMessage(blocked)).toBe(
      "Incoming changes affect files with unsaved edits: .gitattributes, .gitignore, docs/План.md. Save or discard these edits and sync again.",
    );
    expect(gitSyncErrorMessage({ ...blocked, files: [] })).toBe(
      "Failed to sync",
    );
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("a failed sync step names the repository, the stage and the cause without Git output", async () => {
  const original = getLocale();
  try {
    await setLocale("en", { reload: false });
    expect(
      gitSyncErrorMessage({
        kind: "git_sync_failed",
        repository: "Research",
        stage: "fetch",
        cause: "file_system_denied",
        stderr: "/Users/private/.git/FETCH_HEAD: Permission denied",
      }),
    ).toBe(
      "Research: Could not receive changes from the remote. The file system denied access to the repository files. Check the permissions of the folder and its .git folder.",
    );
    expect(
      gitSyncErrorMessage({
        kind: "git_sync_failed",
        repository: "Research",
        stage: "push",
        cause: null,
      }),
    ).toBe("Research: Could not publish the changes. The cause is unknown.");
    await setLocale("ru", { reload: false });
    expect(
      gitSyncErrorMessage({
        kind: "git_sync_failed",
        repository: "Исследования",
        stage: "commit",
        cause: "index_locked",
      }),
    ).toBe(
      "Исследования: Не удалось создать коммит слияния. Репозиторием занят другой процесс Git (index.lock). Дождитесь его завершения; если такого процесса нет, удалите .git/index.lock.",
    );
  } finally {
    await setLocale(original, { reload: false });
  }
});

test("protected branch, repository rules and non-fast-forward rejections are named", async () => {
  const original = getLocale();
  try {
    for (const locale of ["en", "ru"] as const) {
      await setLocale(locale, { reload: false });
      const messages = (
        ["protected_branch", "repository_rules", "non_fast_forward"] as const
      ).map((reason) =>
        gitSyncErrorMessage({ kind: "git_push_rejected", reason }),
      );
      expect(new Set(messages).size).toBe(3);
      for (const message of messages)
        expect(
          message ===
            (locale === "en"
              ? "Failed to sync"
              : "Не удалось синхронизировать"),
        ).toBe(false);
    }
    await setLocale("en", { reload: false });
    expect(
      gitSyncErrorMessage({
        kind: "git_push_rejected",
        reason: "protected_branch",
      }).startsWith(
        "The Git provider rejected the push: the branch is protected.",
      ),
    ).toBe(true);
  } finally {
    await setLocale(original, { reload: false });
  }
});
