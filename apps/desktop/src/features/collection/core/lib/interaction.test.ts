import { expect, test } from "bun:test";

import {
  createCollectionCorePresentationScope,
  resolveCollectionCoreFocusIndex,
  runCollectionCoreCallback,
} from "./interaction";

test("list and Gallery focus navigation stays within the snapshot", () => {
  expect(
    resolveCollectionCoreFocusIndex({
      currentIndex: 2,
      itemCount: 5,
      key: "ArrowDown",
      renderer: "list",
    }),
  ).toBe(3);
  expect(
    resolveCollectionCoreFocusIndex({
      cardColumns: 3,
      currentIndex: 4,
      itemCount: 8,
      key: "ArrowUp",
      renderer: "gallery",
    }),
  ).toBe(1);
  expect(
    resolveCollectionCoreFocusIndex({
      currentIndex: 0,
      itemCount: 5,
      key: "ArrowUp",
      renderer: "list",
    }),
  ).toBeNull();
  expect(
    resolveCollectionCoreFocusIndex({
      currentIndex: 3,
      itemCount: 5,
      key: "Home",
      renderer: "gallery",
    }),
  ).toBe(0);
});

test("callback rejection is returned as an explicit diagnostic result", async () => {
  const result = await runCollectionCoreCallback(
    () => Promise.reject(new Error("Repository is read-only")),
    "Fallback",
  );

  expect(result).toEqual({
    message: "Repository is read-only",
    ok: false,
  });
});

test("non-error callback rejection uses the localized fallback", async () => {
  const result = await runCollectionCoreCallback(
    () => Promise.reject("failed"),
    "The action failed.",
  );

  expect(result).toEqual({
    message: "The action failed.",
    ok: false,
  });
});

test("presentation scope keeps instances and presentations isolated", () => {
  expect(
    createCollectionCorePresentationScope("a:b", "c") ===
      createCollectionCorePresentationScope("a", "b:c"),
  ).toBe(false);
  expect(
    createCollectionCorePresentationScope("space:one", "actors") ===
      createCollectionCorePresentationScope("space:two", "actors"),
  ).toBe(false);
});
