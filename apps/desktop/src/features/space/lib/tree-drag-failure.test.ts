import { expect, test } from "bun:test";
import { treeDragFailureToast } from "./tree-drag-failure";

test("an unreadable page order names its file", () => {
  expect(
    treeDragFailureToast({
      kind: "tree_order_unreadable",
      path: "/space/.svode/order.json",
    }).description,
  ).toBe(
    "Can't read /space/.svode/order.json. Fix or remove the file, then try again.",
  );
});

test("other move failures keep the generic message", () => {
  expect(treeDragFailureToast("IO error: denied")).toEqual({
    title: "Failed to move file",
  });
});
