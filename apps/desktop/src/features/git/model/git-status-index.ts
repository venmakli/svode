import type { FileGitStatus, GitStatus } from "./types";
import { normalizeGitStatusPath } from "./git-paths";

/** The status files at one normalized path, in status order. */
export interface GitStatusPathEntry {
  files: FileGitStatus[];
  conflicts: number;
}

/** The status files below one normalized folder path ("" is the whole Space). */
export interface GitStatusFolderEntry {
  count: number;
  conflicts: number;
  /** The first such file in status order. */
  first: FileGitStatus;
}

/**
 * The files of one status object by normalized path and by every folder
 * above them, built once per status object so that a lookup by path costs
 * the depth of the path instead of a scan of the status (DF-276 R2).
 */
export interface GitStatusPathIndex {
  paths: ReadonlyMap<string, GitStatusPathEntry>;
  folders: ReadonlyMap<string, GitStatusFolderEntry>;
}

const INDEXES = new WeakMap<GitStatus, GitStatusPathIndex>();

export function gitStatusPathIndex(status: GitStatus): GitStatusPathIndex {
  let index = INDEXES.get(status);
  if (!index) {
    index = buildGitStatusPathIndex(status.files);
    INDEXES.set(status, index);
  }
  return index;
}

/** The first status file at `path`, if the status lists it. */
export function gitStatusFileAt(
  status: GitStatus | null | undefined,
  path: string,
): FileGitStatus | undefined {
  if (!status) return undefined;
  return gitStatusPathIndex(status).paths.get(normalizeGitStatusPath(path))
    ?.files[0];
}

/** Whether the status holds `path` in conflict. */
export function gitStatusPathInConflict(
  status: GitStatus | null | undefined,
  path: string,
): boolean {
  if (!status) return false;
  const entry = gitStatusPathIndex(status).paths.get(
    normalizeGitStatusPath(path),
  );
  return (entry?.conflicts ?? 0) > 0;
}

function buildGitStatusPathIndex(
  files: readonly FileGitStatus[],
): GitStatusPathIndex {
  const paths = new Map<string, GitStatusPathEntry>();
  const folders = new Map<string, GitStatusFolderEntry>();
  for (const file of files) {
    const path = normalizeGitStatusPath(file.path);
    const conflict = file.state === "conflict" ? 1 : 0;
    const entry = paths.get(path);
    if (entry) {
      entry.files.push(file);
      entry.conflicts += conflict;
    } else {
      paths.set(path, { files: [file], conflicts: conflict });
    }
    if (!path) continue;
    // `path` is below "" and below the prefix before each of its slashes,
    // exactly the folders for which `isGitStatusPathDescendant` holds.
    addToFolder(folders, "", file, conflict);
    for (
      let slash = path.indexOf("/");
      slash !== -1;
      slash = path.indexOf("/", slash + 1)
    ) {
      addToFolder(folders, path.slice(0, slash), file, conflict);
    }
  }
  return { paths, folders };
}

function addToFolder(
  folders: Map<string, GitStatusFolderEntry>,
  folder: string,
  file: FileGitStatus,
  conflict: number,
) {
  const entry = folders.get(folder);
  if (entry) {
    entry.count++;
    entry.conflicts += conflict;
  } else {
    folders.set(folder, { count: 1, conflicts: conflict, first: file });
  }
}
