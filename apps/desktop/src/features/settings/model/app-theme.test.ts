import { expect, test } from "bun:test";

import { isAppTheme, normalizeAppTheme } from "./app-theme";

test("normalizes only supported app themes", () => {
  expect(isAppTheme("system")).toBe(true);
  expect(isAppTheme("light")).toBe(true);
  expect(isAppTheme("dark")).toBe(true);
  expect(isAppTheme("sepia")).toBe(false);
  expect(normalizeAppTheme("dark")).toBe("dark");
  expect(normalizeAppTheme("unsupported")).toBe("system");
  expect(normalizeAppTheme(undefined)).toBe("system");
});
