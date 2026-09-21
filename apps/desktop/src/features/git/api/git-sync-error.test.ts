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
