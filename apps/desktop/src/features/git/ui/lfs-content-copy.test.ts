import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import type { GitLfsUnsent } from "../model";
import {
  lfsMegabytes,
  lfsUnsentDescription,
  lfsUnsentHint,
  lfsUnsentWarning,
} from "./lfs-content-copy";

const MIB = 1024 * 1024;

function unsent(
  count: number,
  stop: GitLfsUnsent["stop"] = { kind: "unreachable" },
): GitLfsUnsent {
  return {
    files: Array.from({ length: count }, (_, index) => ({
      path: `media/file-${index}.mov`,
      size: 20 * MIB,
    })),
    bytes: count * 20 * MIB,
    stop,
  };
}

async function inLocale(locale: "ru" | "en", run: () => void) {
  const original = getLocale();
  try {
    await setLocale(locale, { reload: false });
    run();
  } finally {
    await setLocale(original, { reload: false });
  }
}

test("sizes read in megabytes and a tiny file is not shown as zero", async () => {
  await inLocale("ru", () => {
    expect(lfsMegabytes(125_829_120)).toBe("120 МБ");
    expect(lfsMegabytes(419_430)).toBe("0,4 МБ");
    expect(lfsMegabytes(60_000)).toBe("0,1 МБ");
    expect(lfsMegabytes(2_048)).toBe("< 0,1 МБ");
  });
  await inLocale("en", () => {
    expect(lfsMegabytes(2_048)).toBe("< 0.1 MB");
  });
});

test("the sync warning names the files not sent with their plural forms and the reason", async () => {
  await inLocale("ru", () => {
    expect(lfsUnsentWarning(unsent(2))).toBe(
      "Изменения опубликованы, но 2 файла не отправлены: сервер файлов недоступен. Они отправятся при следующей синхронизации.",
    );
    expect(lfsUnsentWarning(unsent(1))).toBe(
      "Изменения опубликованы, но 1 файл не отправлен: сервер файлов недоступен. Он отправится при следующей синхронизации.",
    );
    expect(lfsUnsentWarning(unsent(5))).toStartWith(
      "Изменения опубликованы, но 5 файлов не отправлены",
    );
    expect(
      lfsUnsentWarning(
        unsent(1, { kind: "stalled", path: "clips/video.mov", size: 95 * MIB }),
      ),
    ).toBe(
      "Изменения опубликованы, но 1 файл не отправлен: отправка файла «video.mov» (95 МБ) остановлена: 2 минуты не было передачи данных. Он отправится при следующей синхронизации.",
    );
    expect(
      lfsUnsentWarning(
        unsent(1, { kind: "other", detail: "LFS: batch response: 500." }),
      ),
    ).toContain("не отправлен: LFS: batch response: 500. Он отправится");
  });
  await inLocale("en", () => {
    expect(lfsUnsentWarning(unsent(2))).toBe(
      "Changes are published, but 2 files are not sent: the file server is unreachable. They will be sent with the next sync.",
    );
    expect(lfsUnsentWarning(unsent(1, { kind: "no-access" }))).toBe(
      "Changes are published, but 1 file is not sent: no access to the file server. It will be sent with the next sync.",
    );
  });
});

test("every reason reads in the description and the hint of the LFS place", async () => {
  await inLocale("ru", () => {
    expect(lfsUnsentDescription(unsent(2))).toBe(
      "Не отправлено 2 файла · 40 МБ. Сервер файлов недоступен.",
    );
    expect(lfsUnsentDescription(unsent(1, { kind: "not-on-device" }))).toBe(
      "Не отправлен 1 файл · 20 МБ. Файла нет на устройстве.",
    );
    expect(
      lfsUnsentDescription(
        unsent(1, { kind: "stalled", path: null, size: null }),
      ),
    ).toBe(
      "Не отправлен 1 файл · 20 МБ. Отправка остановлена: 2 минуты не было передачи данных.",
    );
    expect(lfsUnsentHint(unsent(2))).toBe(
      "Не отправлено 2 файла · 40 МБ. Сервер файлов недоступен — изменения опубликованы, файлы отправятся при следующей синхронизации.",
    );
    expect(lfsUnsentHint(unsent(2, { kind: "no-access" }))).toBe(
      "Не отправлено 2 файла · 40 МБ. Нет доступа к серверу файлов — изменения опубликованы, файлы сохранены на устройстве.",
    );
    expect(lfsUnsentHint(unsent(1, { kind: "other", detail: " " }))).toBe(
      "Не отправлен 1 файл · 20 МБ. Изменения опубликованы, файлы отправятся при следующей синхронизации.",
    );
  });
  await inLocale("en", () => {
    expect(lfsUnsentDescription(unsent(1))).toBe(
      "1 file not sent · 20 MB. The file server is unreachable.",
    );
  });
});
