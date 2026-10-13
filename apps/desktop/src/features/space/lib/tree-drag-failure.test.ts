import { expect, test } from "bun:test";
import { treeDragFailureToast } from "./tree-drag-failure";

test("an unreadable page order names its file", () => {
  const toast = treeDragFailureToast({
    kind: "tree_order_unreadable",
    message: "Page order file /space/.svode/order.json cannot be read",
    path: "/space/.svode/order.json",
  });

  expect(toast.title).toBe("Page order not saved");
  expect(toast.description).toBe(
    "Can't read /space/.svode/order.json. Fix or remove the file, then try again.",
  );
});

test("other move failures keep the generic message", () => {
  expect(treeDragFailureToast("IO error: denied")).toEqual({
    title: "Failed to move file",
  });
  expect(treeDragFailureToast({ kind: "source_busy", path: "a.md" })).toEqual({
    title: "Failed to move file",
  });
});
