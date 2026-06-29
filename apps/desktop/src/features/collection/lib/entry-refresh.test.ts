import { expect, test } from "bun:test";
import type { Entry } from "@/features/entry";
import {
  collectionEntriesTargetKey,
  mergeStableEntriesByPath,
  sameStringSet,
} from "./entry-refresh";

function entry(
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
  } satisfies Entry;
}

test("mergeStableEntriesByPath reuses an identical snapshot", () => {
  const first = entry("tasks/a.md", "A", { status: "todo" });
  const current = [first];
  const next = [entry("tasks/a.md", "A", { status: "todo" })];

  const merged = mergeStableEntriesByPath(current, next);

  expect(merged).toBe(current);
  expect(merged[0]).toBe(first);
});

test("mergeStableEntriesByPath preserves unchanged entries while replacing changed ones", () => {
  const first = entry("tasks/a.md", "A", { status: "todo" });
  const second = entry("tasks/b.md", "B", { status: "todo" });
  const changedSecond = entry("tasks/b.md", "B", { status: "done" });
  const current = [first, second];

  const merged = mergeStableEntriesByPath(current, [
    entry("tasks/a.md", "A", { status: "todo" }),
    changedSecond,
  ]);

  expect(merged === current).toBe(false);
  expect(merged[0]).toBe(first);
  expect(merged[1]).toBe(changedSecond);
});

test("mergeStableEntriesByPath keeps the next order without replacing equal entries", () => {
  const first = entry("tasks/a.md", "A");
  const second = entry("tasks/b.md", "B");

  const merged = mergeStableEntriesByPath(
    [first, second],
    [entry("tasks/b.md", "B"), entry("tasks/a.md", "A")],
  );

  expect(merged).toEqual([second, first]);
  expect(merged[0]).toBe(second);
  expect(merged[1]).toBe(first);
});

test("sameStringSet compares values without depending on set identity", () => {
  expect(sameStringSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  expect(sameStringSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
});

test("collectionEntriesTargetKey changes when collection target changes", () => {
  const base = collectionEntriesTargetKey({
    spacePath: "/space",
    projectPath: "/project",
    collectionPath: "tasks",
  });

  expect(
    collectionEntriesTargetKey({
      spacePath: "/space",
      projectPath: "/project",
      collectionPath: "notes",
    }) === base,
  ).toBe(false);
  expect(
    collectionEntriesTargetKey({
      spacePath: "/space",
      projectPath: null,
      collectionPath: "tasks",
    }) === base,
  ).toBe(false);
});
