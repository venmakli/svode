import { expect, test } from "bun:test";
import type { Page } from "@/features/page";
import {
  collectionItemsTargetKey,
  mergeStableItemsByPath,
  rebaseCollectionItems,
  rebaseCollectionPathSet,
  sameStringSet,
} from "./item-refresh";

function item(
  path: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return {
    path,
    body: "",
    meta: {
      title,
      icon: null,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      extra,
    },
  } satisfies Page;
}

test("mergeStableItemsByPath reuses an identical snapshot", () => {
  const first = item("tasks/a.md", "A", { status: "todo" });
  const current = [first];
  const next = [item("tasks/a.md", "A", { status: "todo" })];

  const merged = mergeStableItemsByPath(current, next);

  expect(merged).toBe(current);
  expect(merged[0]).toBe(first);
});

test("mergeStableItemsByPath preserves unchanged items while replacing changed ones", () => {
  const first = item("tasks/a.md", "A", { status: "todo" });
  const second = item("tasks/b.md", "B", { status: "todo" });
  const changedSecond = item("tasks/b.md", "B", { status: "done" });
  const current = [first, second];

  const merged = mergeStableItemsByPath(current, [
    item("tasks/a.md", "A", { status: "todo" }),
    changedSecond,
  ]);

  expect(merged === current).toBe(false);
  expect(merged[0]).toBe(first);
  expect(merged[1]).toBe(changedSecond);
});

test("mergeStableItemsByPath keeps the next order without replacing equal items", () => {
  const first = item("tasks/a.md", "A");
  const second = item("tasks/b.md", "B");

  const merged = mergeStableItemsByPath(
    [first, second],
    [item("tasks/b.md", "B"), item("tasks/a.md", "A")],
  );

  expect(merged).toEqual([second, first]);
  expect(merged[0]).toBe(second);
  expect(merged[1]).toBe(first);
});

test("sameStringSet compares values without depending on set identity", () => {
  expect(sameStringSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  expect(sameStringSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
});

test("collectionItemsTargetKey changes when collection target changes", () => {
  const base = collectionItemsTargetKey({
    spacePath: "/space",
    projectPath: "/project",
    collectionPath: "tasks",
  });

  expect(
    collectionItemsTargetKey({
      spacePath: "/space",
      projectPath: "/project",
      collectionPath: "notes",
    }) === base,
  ).toBe(false);
  expect(
    collectionItemsTargetKey({
      spacePath: "/space",
      projectPath: null,
      collectionPath: "tasks",
    }) === base,
  ).toBe(false);
});

test("rebases loaded collection items without clearing the current view", () => {
  const items = [
    item("tasks/one.md", "One"),
    item("tasks/nested/two.md", "Two"),
    item("other/three.md", "Three"),
  ];

  expect(rebaseCollectionItems(items, "tasks", "Задачи")).toEqual([
    { ...items[0], path: "Задачи/one.md" },
    { ...items[1], path: "Задачи/nested/two.md" },
    items[2],
  ]);
  expect(
    rebaseCollectionPathSet(
      new Set(["tasks", "tasks/nested", "other"]),
      "tasks",
      "Задачи",
    ),
  ).toEqual(new Set(["Задачи", "Задачи/nested", "other"]));
});
