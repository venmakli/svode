import { expect, test } from "bun:test";
import {
  selectFileChangeIndicator,
  selectSpaceRootChangeIndicator,
  selectTreeNodeChangeIndicator,
  useGitStore,
  type FileChangeIndicator,
} from "./git-store";
import {
  containerPathForNodePath,
  isGitStatusPathDescendant,
  normalizeGitStatusPath,
} from "./git-paths";
import { gitStatusFileAt, gitStatusPathInConflict } from "./git-status-index";
import { gitStatusHasDirtyPath } from "./save-scope";
import type { FileGitState, FileGitStatus, GitStatus } from "./types";

const SPACE = "/space";

// DF-276 R2: the paths of a status object are read and normalized once;
// a selector call afterwards looks its path up instead of scanning.
test("a status object is indexed once and selector calls do not scan its files", () => {
  let reads = 0;
  const files: FileGitStatus[] = Array.from({ length: 2_000 }, (_, index) => {
    const path = `notes/${index % 10}/page-${index}.md`;
    return {
      get path() {
        reads++;
        return path;
      },
      state: index === 7 ? "conflict" : "untracked",
    };
  });
  const state = gitState(status(files));

  for (let call = 0; call < 3; call++) {
    for (let index = 0; index < 2_000; index++) {
      selectFileChangeIndicator(
        state,
        SPACE,
        `notes/${index % 10}/page-${index}.md`,
      );
    }
    for (let folder = 0; folder < 10; folder++) {
      selectTreeNodeChangeIndicator(state, SPACE, {
        path: `notes/${folder}/README.md`,
        isContainer: true,
      });
    }
    selectSpaceRootChangeIndicator(state, SPACE);
    gitStatusPathInConflict(state.statuses[SPACE], "notes/7/page-7.md");
    gitStatusHasDirtyPath(state.statuses[SPACE], "notes/1/page-1.md");
  }
  expect(reads).toBe(2_000);

  // A new status object is indexed once more.
  const next = gitState(status([...files]));
  selectSpaceRootChangeIndicator(next, SPACE);
  selectFileChangeIndicator(next, SPACE, "notes/0/page-0.md");
  expect(reads).toBe(4_000);
});

test("indexed indicators and path checks keep the semantics of a status scan", () => {
  const states: FileGitState[] = [
    "modified",
    "untracked",
    "deleted",
    "conflict",
  ];
  const names = ["README.md", "a.md", "b", "schema.yaml"];
  const folders = ["", "docs", "docs/sub", "docs\\win", "notes", "/lead/"];
  let seed = 7;
  const random = (limit: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };
  const pathOf = () => {
    const folder = folders[random(folders.length)];
    const name = names[random(names.length)];
    return folder ? `${folder}/${name}` : name;
  };
  for (let round = 0; round < 200; round++) {
    const files: FileGitStatus[] = Array.from({ length: random(12) }, () => ({
      path: pathOf(),
      // Conflicts are rarer, so dirty states and their first file show.
      state: states[random(10) === 0 ? 3 : random(3)],
    }));
    const state = gitState(status(files));
    const targets = [
      ...files.map((file) => file.path),
      ...Array.from({ length: 6 }, pathOf),
      "docs",
      "",
    ];
    for (const path of targets) {
      for (const pendingWrite of [false, true]) {
        expect(
          selectFileChangeIndicator(state, SPACE, path, pendingWrite),
        ).toEqual(scanIndicator(files, [path], null, pendingWrite));
        expect(
          selectTreeNodeChangeIndicator(state, SPACE, {
            path,
            isContainer: true,
            pendingWrite,
          }),
        ).toEqual(
          scanIndicator(
            files,
            [normalizeGitStatusPath(path)],
            containerPathForNodePath(normalizeGitStatusPath(path)),
            pendingWrite,
          ),
        );
      }
      const normalized = normalizeGitStatusPath(path);
      expect(gitStatusPathInConflict(state.statuses[SPACE], path)).toBe(
        files.some(
          (file) =>
            file.state === "conflict" &&
            normalizeGitStatusPath(file.path) === normalized,
        ),
      );
      expect(gitStatusFileAt(state.statuses[SPACE], path)).toBe(
        files.find((file) => normalizeGitStatusPath(file.path) === normalized),
      );
    }
    expect(selectSpaceRootChangeIndicator(state, SPACE)).toEqual(
      scanIndicator(files, ["README.md"], "", false),
    );
  }
});

/** The indicator of a target by a scan of the status, as before DF-276. */
function scanIndicator(
  files: FileGitStatus[],
  selfTargets: string[],
  descendantTarget: string | null,
  pendingWrite: boolean,
): FileChangeIndicator {
  const selfPaths = new Set(selfTargets.map(normalizeGitStatusPath));
  const descendantPath =
    descendantTarget === null ? null : normalizeGitStatusPath(descendantTarget);
  const selfFiles: FileGitStatus[] = [];
  const descendantFiles: FileGitStatus[] = [];
  for (const file of files) {
    const filePath = normalizeGitStatusPath(file.path);
    if (selfPaths.has(filePath)) selfFiles.push(file);
    else if (
      descendantPath !== null &&
      isGitStatusPathDescendant(filePath, descendantPath)
    )
      descendantFiles.push(file);
  }
  if ([...selfFiles, ...descendantFiles].some((f) => f.state === "conflict"))
    return { kind: "conflict" };
  const hasSelf = selfFiles.length > 0 || pendingWrite;
  const hasDescendants = descendantFiles.length > 0;
  if (!hasSelf && !hasDescendants) return { kind: "clean" };
  const first = selfFiles[0] ?? descendantFiles[0];
  return {
    kind: "dirty",
    reason:
      pendingWrite && selfFiles.length === 0 ? "pending_write" : "git_dirty",
    scope:
      hasSelf && hasDescendants ? "mixed" : hasSelf ? "self" : "descendants",
    ...(first ? { state: first.state } : {}),
  };
}

function gitState(spaceStatus: GitStatus) {
  return { ...useGitStore.getState(), statuses: { [SPACE]: spaceStatus } };
}

function status(files: FileGitStatus[]): GitStatus {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: files.length > 0,
    hasConflicts: files.some((file) => file.state === "conflict"),
    tracking: null,
    files,
    totalFiles: files.length,
    omittedFiles: 0,
  };
}
