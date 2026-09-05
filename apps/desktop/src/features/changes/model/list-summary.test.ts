import { expect, test } from "bun:test";
import type { FileGitState } from "@/features/git";
import { filterChanges, summarizeChanges } from "./list-summary";

test("filters count only the inspection scope and retain conflicts as their own type", () => {
  const files = new Map<string, { state: FileGitState }>([
    ["a", { state: "modified" as const }],
    ["b", { state: "deleted" as const }],
    ["c", { state: "untracked" as const }],
    ["d", { state: "conflict" as const }],
    ["outside", { state: "deleted" as const }],
  ]);
  const paths = ["a", "b", "c", "d"];
  expect(filterChanges(paths, files, "all")).toEqual({
    paths,
    counts: { all: 4, modified: 1, deleted: 1, untracked: 1, conflict: 1 },
  });
  for (const [path, { state }] of [...files].slice(0, 4))
    expect(filterChanges(paths, files, state).paths).toEqual([path]);
});

test("summary distinguishes loading, unavailable files and known zero changes", () => {
  const stats = {
    a: { path: "a", additions: 7, deletions: 3 },
    b: { path: "b", additions: 0, deletions: 0 },
    c: { path: "c", additions: null, deletions: null },
    outside: { path: "outside", additions: 999, deletions: 999 },
  };
  expect(summarizeChanges(["a", "b", "c", "pending"], stats)).toEqual({
    additions: 7,
    deletions: 3,
    counted: 2,
    pending: 1,
    total: 4,
  });
  expect(summarizeChanges(["c"], stats)).toEqual({
    additions: 0,
    deletions: 0,
    counted: 0,
    pending: 0,
    total: 1,
  });
  expect(summarizeChanges([], stats)).toEqual({
    additions: 0,
    deletions: 0,
    counted: 0,
    pending: 0,
    total: 0,
  });
});
