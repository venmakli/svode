import { expect, test } from "bun:test";
import * as m from "@/paraglide/messages.js";

// The sync conflict message picks the plural form of the file count (DF-304 R1).
test("the sync conflict message agrees with the file count in Russian", () => {
  const ru = (count: number): string =>
    m.git_sync_conflict({ count }, { locale: "ru" });
  expect(ru(1)).toBe("Конфликт синхронизации в 1 файле");
  expect(ru(2)).toBe("Конфликт синхронизации в 2 файлах");
  expect(ru(5)).toBe("Конфликт синхронизации в 5 файлах");
  expect(ru(11)).toBe("Конфликт синхронизации в 11 файлах");
  expect(ru(21)).toBe("Конфликт синхронизации в 21 файле");
  expect(ru(22)).toBe("Конфликт синхронизации в 22 файлах");
});

test("the sync conflict message agrees with the file count in English", () => {
  const en = (count: number): string =>
    m.git_sync_conflict({ count }, { locale: "en" });
  expect(en(1)).toBe("Sync conflict in 1 file");
  expect(en(2)).toBe("Sync conflict in 2 files");
});
