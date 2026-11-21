import { expect, test } from "bun:test";

import { setLocale } from "@/paraglide/runtime";

import { attachmentImportRefusalMessage } from "./import-refusal";

const refusal = (fields: Record<string, unknown>) => ({
  kind: "lfs_not_ready",
  message: "Git LFS route is not ready: …",
  code: null,
  ...fields,
});

test("a Git LFS refusal of an import names its reason in the interface language", () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [
      { reason: "s3_not_connected", code: "S3_NOT_CONNECTED" },
      "File not added: this device is not connected to the S3 storage of the project — choose S3 keys in Settings → Storage",
      "Файл не добавлен: это устройство не подключено к хранилищу S3 проекта — выберите ключи S3 в Настройках → Хранилище",
    ],
    [
      { reason: "lfs_tooling_unavailable", code: "LFS_TOOLING_UNAVAILABLE" },
      "File not added: Git LFS is not ready on this device — install git-lfs or reinstall Svode",
      "Файл не добавлен: Git LFS не готов на этом устройстве — установите git-lfs или переустановите Svode",
    ],
    [
      {
        reason: "strategy_mismatch",
        code: "STORAGE_STRATEGY_MISMATCH",
        strategy: "lfs-future",
      },
      "File not added: the storage strategy “lfs-future” comes from a newer Svode version — update Svode",
      "Файл не добавлен: стратегию хранения «lfs-future» задала более новая версия Svode — обновите Svode",
    ],
    [
      {
        reason: "strategy_mismatch",
        code: "STORAGE_STRATEGY_MISMATCH",
        strategy: "in-git",
      },
      "File not added: the storage strategy of the project does not use Git LFS — check Settings → Storage",
      "Файл не добавлен: стратегия хранения проекта не использует Git LFS — проверьте Настройки → Хранилище",
    ],
    [
      { reason: "s3_address_missing", code: "STORAGE_STRATEGY_MISMATCH" },
      "File not added: the project uses Git LFS + S3 without an S3 storage address — set it in Settings → Storage",
      "Файл не добавлен: проект использует Git LFS + S3 без адреса хранилища S3 — укажите его в Настройках → Хранилище",
    ],
    [
      { reason: "secret", code: "SECRET_NOT_FOUND", secret: "S3_KEY" },
      "File not added: the Secret S3_KEY of the S3 storage has no value on this device — set it in Settings → Variables",
      "Файл не добавлен: у Secret S3_KEY хранилища S3 нет значения на этом устройстве — задайте его в Настройках → Переменные",
    ],
    [
      { reason: "secret", code: "SECRET_FILE_UNSAFE", secret: "S3_KEY" },
      "File not added: the Secret S3_KEY of the S3 storage cannot be read on this device",
      "Файл не добавлен: Secret S3_KEY хранилища S3 не удаётся прочитать на этом устройстве",
    ],
    [
      { reason: "s3_check_failed", code: "S3_CHECK_FAILED" },
      "File not added: the S3 storage check failed — check the endpoint, bucket, region and key permissions in Settings → Storage",
      "Файл не добавлен: проверка хранилища S3 не прошла — проверьте Endpoint, Bucket, Region и права ключа в Настройках → Хранилище",
    ],
    [
      { reason: "remote_offline" },
      "File not added: the Git LFS server is unreachable",
      "Файл не добавлен: сервер Git LFS недоступен",
    ],
  ];
  for (const [fields, en, ru] of cases) {
    expect(attachmentImportRefusalMessage(refusal(fields))).toBe(en);
    setLocale("ru", { reload: false });
    try {
      expect(attachmentImportRefusalMessage(refusal(fields))).toBe(ru);
    } finally {
      setLocale("en", { reload: false });
    }
  }
});

test("another refusal keeps the text the backend gives it", () => {
  expect(
    attachmentImportRefusalMessage("Storage: the source file is too large"),
  ).toBe("File not added: Storage: the source file is too large");
  expect(
    attachmentImportRefusalMessage({
      kind: "source_busy",
      message: "Source is busy: another Svode operation is writing a.md",
      path: "a.md",
    }),
  ).toBe(
    "File not added: Source is busy: another Svode operation is writing a.md",
  );
  expect(
    attachmentImportRefusalMessage({
      kind: "lfs_not_ready",
      reason: "reason_of_a_newer_build",
      message: "Git LFS route is not ready: something new",
    }),
  ).toBe("File not added: Git LFS route is not ready: something new");
});
