import { expect, test } from "bun:test";
import { treeOrderUnreadableToast } from "./tree-order-error";

test("an unreadable page order names its file", () => {
  expect(
    treeOrderUnreadableToast({
      kind: "tree_order_unreadable",
      message: "Page order file /space/.svode/order.json cannot be read",
      path: "/space/.svode/order.json",
    }),
  ).toEqual({
    title: "Page order not saved",
    description:
      "Can't read /space/.svode/order.json. Fix or remove the file, then try again.",
  });
});

test("other errors are left to the caller", () => {
  expect(treeOrderUnreadableToast("IO error: denied")).toBeNull();
  expect(
    treeOrderUnreadableToast({ kind: "source_busy", path: "a.md" }),
  ).toBeNull();
});
