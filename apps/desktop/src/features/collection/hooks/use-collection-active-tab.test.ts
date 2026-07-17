import { expect, test } from "bun:test";
import { resolveCollectionViewName } from "./use-collection-active-tab";

const views = [{ name: "Board" }, { name: "Calendar" }];

test("restores an available collection view name", () => {
  expect(resolveCollectionViewName("Calendar", views)).toBe("Calendar");
});

test("falls back to the first view for a stale collection view name", () => {
  expect(resolveCollectionViewName("Deleted", views)).toBe("Board");
});

test("uses null when a collection has no available views", () => {
  expect(resolveCollectionViewName("Deleted", [])).toBeNull();
});
