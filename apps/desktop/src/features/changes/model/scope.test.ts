import { expect, test } from "bun:test";
import { resolveGitSaveAllScope } from "@/features/git/editor";
import type { GitStatus } from "@/features/git";
import {
  inspectionPaths,
  resolveInspectionScope,
  type ChangesTarget,
} from "./scope";

const target: ChangesTarget = {
  kind: "page",
  sourceShape: "file",
  spacePath: "/project",
  path: "contract/note.md",
  name: "Note",
};
const status: GitStatus = {
  branch: "main",
  ahead: 0,
  behind: 0,
  hasStaged: false,
  hasUnstaged: true,
  hasConflicts: false,
  tracking: null,
  files: [
    "contract/note.md",
    "contract/sibling.md",
    "contract/manual.pdf",
    "contractor/note.md",
  ].map((path) => ({ path, state: "modified" })),
};

test("exact inspection preserves containing-scope Save all", () => {
  expect(inspectionPaths(resolveInspectionScope(target), status)).toEqual([
    "contract/note.md",
  ]);
  const all = resolveGitSaveAllScope({
    activePath: target.path,
    tree: [
      {
        path: "contract/README.md",
        hasChildren: true,
        children: [{ path: target.path }],
      },
    ],
  });
  expect(all.kind).toBe("container");
  expect(all.path).toBe("contract");
});

test("directory owners include all source kinds with segment containment", () => {
  const scope = resolveInspectionScope({
    ...target,
    sourceShape: "directory",
    path: "contract/README.md",
  });
  expect(inspectionPaths(scope, status)).toEqual([
    "contract/note.md",
    "contract/sibling.md",
    "contract/manual.pdf",
  ]);
  expect(
    resolveInspectionScope({
      ...target,
      kind: "owner",
      sourceShape: "directory",
      path: "contract",
    }),
  ).toEqual(scope);
});

test("Space and Project inspect only the supplied effective status snapshot", () => {
  for (const kind of ["space", "project"] as const) {
    expect(
      inspectionPaths(resolveInspectionScope({ ...target, kind }), status)
        .length,
    ).toBe(4);
  }
  expect(inspectionPaths(resolveInspectionScope(target), undefined)).toEqual(
    [],
  );
});
