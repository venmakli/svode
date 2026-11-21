import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import type { LfsMissing } from "../model";
import { lfsMissingDescription } from "./lfs-missing-copy";

const MIB = 1024 * 1024;

function missing(count: number, overrides: Partial<LfsMissing> = {}) {
  return {
    files: Array.from({ length: count }, (_, index) => ({
      path: `media/file-${index}.png`,
      size: MIB,
    })),
    bytes: count * MIB,
    stop: { kind: "stalled" },
    ...overrides,
  } satisfies LfsMissing;
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

test("the number of files left reads with its Russian and English plural forms", async () => {
  await inLocale("ru", () => {
    expect(lfsMissingDescription(missing(1))).toBe(
      "Не скачан 1 файл · 1 МБ. 2 минуты не было передачи данных.",
    );
    expect(lfsMissingDescription(missing(3))).toStartWith(
      "Не скачано 3 файла · 3 МБ.",
    );
    expect(lfsMissingDescription(missing(5))).toStartWith(
      "Не скачано 5 файлов · 5 МБ.",
    );
    expect(lfsMissingDescription(missing(11))).toStartWith(
      "Не скачано 11 файлов",
    );
    expect(lfsMissingDescription(missing(21))).toStartWith("Не скачан 21 файл");
    expect(lfsMissingDescription(missing(22))).toStartWith(
      "Не скачано 22 файла",
    );
  });
  await inLocale("en", () => {
    expect(lfsMissingDescription(missing(1))).toBe(
      "1 file not downloaded · 1 MB. No data was transferred for 2 minutes.",
    );
    expect(lfsMissingDescription(missing(2))).toStartWith(
      "2 files not downloaded · 2 MB.",
    );
  });
});

test("every stop names its cause; other shows the git-lfs text once punctuated", async () => {
  await inLocale("ru", () => {
    const of = (stop: LfsMissing["stop"]) =>
      lfsMissingDescription(missing(1, { stop }));
    expect(of({ kind: "no-access" })).toEndWith(" Нет доступа к хранилищу.");
    expect(of({ kind: "unreachable" })).toEndWith(" Сервер недоступен.");
    expect(of({ kind: "not-on-server" })).toBe(
      "Не скачан 1 файл · 1 МБ. Файла пока нет на сервере — он скачается, когда его отправит устройство, где его добавили.",
    );
    expect(of({ kind: "other", detail: "batch response: 500\n" })).toBe(
      "Не скачан 1 файл · 1 МБ. batch response: 500.",
    );
    expect(of({ kind: "other", detail: "Smudge error." })).toEndWith(
      " Smudge error.",
    );
    expect(of({ kind: "other", detail: "  " })).toBe(
      "Не скачан 1 файл · 1 МБ.",
    );
  });
});
