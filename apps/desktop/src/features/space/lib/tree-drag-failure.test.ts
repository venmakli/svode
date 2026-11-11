import { afterEach, expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { treeDragFailureToast } from "./tree-drag-failure";

const originalLocale = getLocale();

afterEach(async () => {
  await setLocale(originalLocale, { reload: false });
});

test("an unreadable page order names its file", () => {
  expect(
    treeDragFailureToast(
      {
        kind: "tree_order_unreadable",
        path: "/space/.svode/order.json",
      },
      "Docs",
    ).description,
  ).toBe(
    "Can't read /space/.svode/order.json. Fix or remove the file, then try again.",
  );
});

test("a taken name names itself and its folder", async () => {
  const error = {
    kind: "file_already_exists",
    message: "File already exists: target/note.md",
    path: "target/note.md",
  };
  await setLocale("en", { reload: false });
  expect(treeDragFailureToast(error, "Docs")).toEqual({
    title: "“note.md” is already taken in “target”.",
  });
  await setLocale("ru", { reload: false });
  expect(treeDragFailureToast(error, "Docs")).toEqual({
    title: "Имя «note.md» уже занято в «target».",
  });
});

test("other move failures show the translated move error", async () => {
  await setLocale("en", { reload: false });
  expect(treeDragFailureToast("IO error: denied", "Docs")).toEqual({
    title: "Could not move the item.",
  });
  await setLocale("ru", { reload: false });
  expect(
    treeDragFailureToast({ kind: "source_busy", path: "a.md" }, "Docs"),
  ).toEqual({ title: "Не удалось переместить элемент." });
});
