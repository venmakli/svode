import { expect, test } from "bun:test";

import { resolveScopeSaveShortcutRoute } from "./use-keyboard-shortcuts";

test("Actors owns regular save while shifted save keeps the broad scope", () => {
  expect(resolveScopeSaveShortcutRoute(false, "actors")).toBe("actors");
  expect(resolveScopeSaveShortcutRoute(true, "actors")).toBe("descendants");
  expect(resolveScopeSaveShortcutRoute(false, "readme")).toBe("feedback");
  expect(resolveScopeSaveShortcutRoute(false, "actors", true)).toBe("blocked");
  expect(resolveScopeSaveShortcutRoute(true, "collection", true)).toBe(
    "blocked",
  );
});
