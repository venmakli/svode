import { expect, test } from "bun:test";
import { closeTopPeek, pushPeek } from "./peek-stack";

test("the last opened peek closes first; a removed peek is skipped", () => {
  const closed: string[] = [];
  const removePage = pushPeek(() => closed.push("page"));
  const removeRoutine = pushPeek(() => closed.push("routine"));
  const removeSession = pushPeek(() => closed.push("session"));

  expect(closeTopPeek()).toBe(true);
  removeSession();
  removeRoutine();
  expect(closeTopPeek()).toBe(true);
  removePage();
  expect(closeTopPeek()).toBe(false);
  expect(closed).toEqual(["session", "page"]);
});
