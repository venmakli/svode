import { expect, test } from "bun:test";

import {
  dirtyPathsForGitSaveScope,
  resolveGitSaveAllScope,
  selfPathsForGitSaveScope,
  type GitSaveScopeTreeNode,
} from "./save-scope";
import type { GitStatus } from "./types";

test("resolveGitSaveAllScope uses collection subtree for collection README", () => {
  const scope = resolveGitSaveAllScope({
    activePath: "tasks/README.md",
    tree,
  });

  expect(scope).toEqual({
    kind: "container",
    path: "tasks",
    nodePath: "tasks/README.md",
    hasSchema: true,
    label: "collection",
  });
  expect(dirtyPathsForGitSaveScope(status, scope)).toEqual([
    "tasks/README.md",
    "tasks/schema.yaml",
    "tasks/entry.md",
  ]);
  expect(selfPathsForGitSaveScope(scope)).toEqual(["tasks/README.md"]);
});

test("resolveGitSaveAllScope uses nearest sidebar container for child entries", () => {
  const scope = resolveGitSaveAllScope({
    activePath: "tasks/entry.md",
    tree,
  });

  expect(scope.kind).toBe("container");
  expect(scope.path).toBe("tasks");
  expect(dirtyPathsForGitSaveScope(status, scope).includes("outside.md")).toBe(
    false,
  );
});

test("resolveGitSaveAllScope keeps root leaf save-all scoped to the file", () => {
  const scope = resolveGitSaveAllScope({
    activePath: "outside.md",
    tree,
  });

  expect(scope).toEqual({
    kind: "file",
    path: "outside.md",
    label: "document",
  });
  expect(dirtyPathsForGitSaveScope(status, scope)).toEqual(["outside.md"]);
});

test("resolveGitSaveAllScope uses the whole space for scope home README", () => {
  const scope = resolveGitSaveAllScope({
    activePath: "README.md",
    tree,
  });

  expect(scope).toEqual({ kind: "space", path: "", label: "space" });
  expect(dirtyPathsForGitSaveScope(status, scope)).toEqual([
    "tasks/README.md",
    "tasks/schema.yaml",
    "tasks/entry.md",
    "outside.md",
  ]);
});

const tree: GitSaveScopeTreeNode[] = [
  {
    path: "tasks/README.md",
    has_schema: true,
    kind: "collection",
    children: [{ path: "tasks/entry.md", kind: "document", children: [] }],
  },
  { path: "outside.md", kind: "document", children: [] },
];

const status: GitStatus = {
  branch: "main",
  ahead: 0,
  behind: 0,
  hasStaged: false,
  hasUnstaged: true,
  hasConflicts: false,
  tracking: null,
  files: [
    { path: "tasks/README.md", state: "modified" },
    { path: "tasks/schema.yaml", state: "modified" },
    { path: "tasks/entry.md", state: "modified" },
    { path: "outside.md", state: "modified" },
  ],
};
