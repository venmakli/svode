import { expect, test } from "bun:test";
import type { GitStatus } from "@/features/git";
import type { ChangesTarget } from "./scope";
import {
  sessionArea,
  sessionAreaPaths,
  sessionWorkSpaces,
} from "./session-scope";

function status(paths: string[], omittedFiles = 0): GitStatus {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: true,
    hasConflicts: false,
    tracking: null,
    files: paths.map((path) => ({ path, state: "modified" })),
    totalFiles: paths.length + omittedFiles,
    omittedFiles,
  };
}

const target: ChangesTarget = {
  kind: "session",
  sourceShape: "directory",
  spacePath: "/p",
  projectPath: "/p",
  path: "",
  name: "Project",
  work: {
    spaceKind: "project",
    files: [
      { spaceId: "root", spacePath: "/p", path: "notes/a.md" },
      { spaceId: "root", spacePath: "/p", path: "notes/clean.md" },
      { spaceId: "docs", spacePath: "/p/docs", path: "b.md" },
    ],
  },
};

const statuses = {
  "/p": status(["notes/a.md", "docs/b.md"]),
  "/p/docs": status(["b.md", "other.md"]),
};
const root = { spaceId: "root", spacePath: "/p", paths: ["notes/a.md"] };
const docs = { spaceId: "docs", spacePath: "/p/docs", paths: ["b.md"] };

test("the area is the uncommitted work by repository: an Independent Space apart", () => {
  const area = sessionArea(target, statuses, {
    "/p": "repo-root",
    "/p/docs": "repo-docs",
  });
  expect(area.sections).toEqual([
    { repository: "repo-root", parts: [root] },
    { repository: "repo-docs", parts: [docs] },
  ]);
  expect(area.read).toBe(true);
  // The child Space's file listed in the project status is in the area.
  expect(area.outside).toBe(0);
});

test("an Inline Space joins the section of the project repository", () => {
  const area = sessionArea(target, statuses, {
    "/p": "repo-root",
    "/p/docs": "repo-root",
  });
  expect(area.sections).toEqual([
    { repository: "repo-root", parts: [root, docs] },
  ]);
  expect(sessionAreaPaths(area)).toEqual(["notes/a.md", "b.md"]);
});

test("a Space whose repository is not read yet keeps a section of its own", () => {
  const area = sessionArea(target, statuses, { "/p": "repo-root" });
  expect(area.sections.map((section) => section.repository)).toEqual([
    "repo-root",
    "path:/p/docs",
  ]);
});

test("uncommitted files of the session's Space outside the work are counted", () => {
  const area = sessionArea(target, {
    "/p": status(["notes/a.md", "README.md", "notes/human.md"]),
    "/p/docs": status([]),
  });
  expect(sessionAreaPaths(area)).toEqual(["notes/a.md"]);
  expect(area.outside).toBe(2);
});

test("a clean work and an unread status claim nothing", () => {
  const clean = sessionArea(target, {
    "/p": status([]),
    "/p/docs": status([]),
  });
  expect(clean.sections).toEqual([]);
  expect(clean.outside).toBe(0);
  const unread = sessionArea(target, { "/p": status(["notes/a.md"], 3) });
  expect(unread.read).toBe(false);
  expect(unread.incomplete).toBe(true);
  expect(sessionWorkSpaces(target)).toEqual(["/p", "/p/docs"]);
});
