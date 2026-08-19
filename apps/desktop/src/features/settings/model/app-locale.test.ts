import { expect, test } from "bun:test";

import { isAppLocale, normalizeAppLocale } from "./app-locale";

test("normalizes only supported app locales", () => {
  expect(isAppLocale("en")).toBe(true);
  expect(isAppLocale("ru")).toBe(true);
  expect(isAppLocale("de")).toBe(false);
  expect(normalizeAppLocale("ru")).toBe("ru");
  expect(normalizeAppLocale("unsupported")).toBe("en");
  expect(normalizeAppLocale(undefined)).toBe("en");
});
