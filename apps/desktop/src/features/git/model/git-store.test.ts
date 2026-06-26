import { expect, test } from "bun:test";
import {
  selectFileChangeIndicator,
  selectSpaceRootChangeIndicator,
  selectTreeNodeChangeIndicator,
} from "./git-store";
import type { GitStatus } from "./types";

const SPACE_PATH = "/tmp/svode-space";

test("selectFileChangeIndicator marks untracked leaf files", () => {
  const state = gitState([{ path: "drafts/new.md", state: "untracked" }]);

  expect(selectFileChangeIndicator(state, SPACE_PATH, "drafts/new.md")).toEqual(
    {
      kind: "dirty",
      reason: "git_dirty",
      scope: "self",
      state: "untracked",
    },
  );
});

test("selectTreeNodeChangeIndicator marks containers with dirty descendants", () => {
  const state = gitState([{ path: "docs/new.md", state: "untracked" }]);

  expect(
    selectTreeNodeChangeIndicator(state, SPACE_PATH, {
      path: "docs/README.md",
      isContainer: true,
    }),
  ).toEqual({
    kind: "dirty",
    reason: "git_dirty",
    scope: "descendants",
    state: "untracked",
  });
});

test("selectTreeNodeChangeIndicator treats collection schema as descendant dirty", () => {
  const state = gitState([{ path: "tasks/schema.yaml", state: "modified" }]);

  expect(
    selectTreeNodeChangeIndicator(state, SPACE_PATH, {
      path: "tasks/README.md",
      isContainer: true,
    }),
  ).toEqual({
    kind: "dirty",
    reason: "git_dirty",
    scope: "descendants",
    state: "modified",
  });
});

test("selectTreeNodeChangeIndicator separates mixed container changes", () => {
  const state = gitState([
    { path: "tasks/README.md", state: "modified" },
    { path: "tasks/entries/new.md", state: "untracked" },
  ]);

  expect(
    selectTreeNodeChangeIndicator(state, SPACE_PATH, {
      path: "tasks/README.md",
      isContainer: true,
    }),
  ).toEqual({
    kind: "dirty",
    reason: "git_dirty",
    scope: "mixed",
    state: "modified",
  });
});

test("selectTreeNodeChangeIndicator treats collection templates as descendants", () => {
  const state = gitState([
    { path: "tasks/.templates/default.md", state: "untracked" },
  ]);

  expect(
    selectTreeNodeChangeIndicator(state, SPACE_PATH, {
      path: "tasks/README.md",
      isContainer: true,
    }),
  ).toEqual({
    kind: "dirty",
    reason: "git_dirty",
    scope: "descendants",
    state: "untracked",
  });
});

test("selectSpaceRootChangeIndicator treats README as self and documents as descendants", () => {
  const state = gitState([
    { path: "README.md", state: "modified" },
    { path: "docs/new.md", state: "untracked" },
  ]);

  expect(selectSpaceRootChangeIndicator(state, SPACE_PATH)).toEqual({
    kind: "dirty",
    reason: "git_dirty",
    scope: "mixed",
    state: "modified",
  });
});

test("selectSpaceRootChangeIndicator treats .svode files as descendants", () => {
  const state = gitState([
    { path: ".svode/config.json", state: "modified" },
  ]);

  expect(selectSpaceRootChangeIndicator(state, SPACE_PATH)).toEqual({
    kind: "dirty",
    reason: "git_dirty",
    scope: "descendants",
    state: "modified",
  });
});

test("dirty indicators are referentially stable for React store selectors", () => {
  const state = gitState([{ path: "docs/new.md", state: "untracked" }]);
  const target = {
    path: "docs/README.md",
    isContainer: true,
  };

  expect(selectTreeNodeChangeIndicator(state, SPACE_PATH, target)).toBe(
    selectTreeNodeChangeIndicator(state, SPACE_PATH, target),
  );
});

function gitState(files: GitStatus["files"]) {
  return {
    statuses: {
      [SPACE_PATH]: status(files),
    },
    syncing: {},
    syncError: {},
    cloning: {},
    applyStatus: () => undefined,
    refreshStatus: async () => undefined,
    clear: () => undefined,
    setSyncing: () => undefined,
    setSyncError: () => undefined,
    setCloning: () => undefined,
  };
}

function status(files: GitStatus["files"]): GitStatus {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: files.length > 0,
    hasConflicts: files.some((file) => file.state === "conflict"),
    tracking: null,
    files,
  };
}
