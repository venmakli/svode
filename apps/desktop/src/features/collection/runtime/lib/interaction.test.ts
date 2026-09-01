import { expect, test } from "bun:test";

import {
  createCollectionPresentationScope,
  resolveCollectionFocusIndex,
  runCollectionCallback,
} from "./interaction";

test("list and Gallery focus navigation stays within the snapshot", () => {
  expect(
    resolveCollectionFocusIndex({
      currentIndex: 2,
      itemCount: 5,
      key: "ArrowDown",
      renderer: "list",
    }),
  ).toBe(3);
  expect(
    resolveCollectionFocusIndex({
      cardColumns: 3,
      currentIndex: 4,
      itemCount: 8,
      key: "ArrowUp",
      renderer: "gallery",
    }),
  ).toBe(1);
  expect(
    resolveCollectionFocusIndex({
      currentIndex: 0,
      itemCount: 5,
      key: "ArrowUp",
      renderer: "list",
    }),
  ).toBeNull();
  expect(
    resolveCollectionFocusIndex({
      currentIndex: 3,
      itemCount: 5,
      key: "Home",
      renderer: "gallery",
    }),
  ).toBe(0);
});

test("callback rejection is returned as an explicit diagnostic result", async () => {
  const result = await runCollectionCallback(
    () => Promise.reject(new Error("Repository is read-only")),
    "Fallback",
  );

  expect(result).toEqual({
    message: "Repository is read-only",
    ok: false,
  });
});

test("non-error callback rejection uses the localized fallback", async () => {
  const result = await runCollectionCallback(
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
    createCollectionPresentationScope("a:b", "c") ===
      createCollectionPresentationScope("a", "b:c"),
  ).toBe(false);
  expect(
    createCollectionPresentationScope("space:one", "actors") ===
      createCollectionPresentationScope("space:two", "actors"),
  ).toBe(false);
});
