/**
 * Content deletions, renames and moves started in this Desktop, so an open
 * Page whose path goes away tells them from a change by another writer.
 */
interface OwnPathChange {
  /** A deletion removes its root; a rename or move takes it elsewhere. */
  kind: "deletion" | "relocation";
  spacePath: string;
  /** What the change leaves: the path, or the directory of its README. */
  root: string;
}

/** How an open Page follows a folder above it that this Desktop moves. */
export interface OwnRelocationFollower {
  /** Saves the pending work of the Page before the folder leaves its path. */
  prepare: () => Promise<unknown>;
  /** Takes the Page to its path under the folder's new path. */
  follow: (path: string) => void;
}

interface PathWatch {
  spacePath: string;
  path: string;
  finished: (change: OwnPathChange) => void;
  follower?: OwnRelocationFollower;
}

const runningChanges = new Set<OwnPathChange>();
const watches = new Set<PathWatch>();

function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/g, "");
}

// Like the core delete and rename: a nested README.md stands for its whole
// directory.
export function ownChangeRoot(path: string) {
  const normalized = normalizePath(path);
  return /^(.+)\/readme\.md$/i.exec(normalized)?.[1] ?? normalized;
}

function leavesPage(change: OwnPathChange, spacePath: string, path: string) {
  if (change.spacePath !== normalizePath(spacePath)) return false;
  const page = normalizePath(path);
  return page === change.root || page.startsWith(`${change.root}/`);
}

// A Page inside the moved folder follows it; the folder itself, a file or
// its README, is handed over by the rename or move of that item.
function follows(change: OwnPathChange, watch: PathWatch) {
  return (
    leavesPage(change, watch.spacePath, watch.path) &&
    ownChangeRoot(watch.path) !== change.root
  );
}

async function trackOwnPathChange<T>(
  kind: OwnPathChange["kind"],
  target: { spacePath: string; path: string },
  run: () => Promise<T>,
  leftPath: (result: T) => boolean,
): Promise<T> {
  const change = {
    kind,
    spacePath: normalizePath(target.spacePath),
    root: ownChangeRoot(target.path),
  };
  runningChanges.add(change);
  try {
    if (kind === "relocation")
      await Promise.allSettled(
        [...watches]
          .filter((watch) => watch.follower && follows(change, watch))
          .map((watch) => watch.follower!.prepare()),
      );
    const result = await run();
    if (leftPath(result)) for (const watch of watches) watch.finished(change);
    return result;
  } finally {
    runningChanges.delete(change);
  }
}

/** Runs a content deletion of this Desktop, known to open Pages it removes. */
export function trackOwnContentDeletion<T>(
  target: { spacePath: string; path: string },
  run: () => Promise<T>,
): Promise<T> {
  return trackOwnPathChange("deletion", target, run, () => true);
}

/**
 * Runs a content rename or move of this Desktop, known to open Pages under the
 * path it leaves, once the Pages inside a folder it moves saved their pending
 * work. `leftPath` tells whether the finished one left it: a title rename
 * keeps the path when the file name stays.
 */
export function trackOwnContentRelocation<T>(
  target: { spacePath: string; path: string },
  run: () => Promise<T>,
  leftPath: (result: T) => boolean = () => true,
): Promise<T> {
  return trackOwnPathChange("relocation", target, run, leftPath);
}

/**
 * Takes the open Pages inside the folder this Desktop renamed or moved from
 * `from` to `to` to the same place under `to`, once that change finished.
 */
export function followOwnContentRelocation(
  spacePath: string,
  from: string,
  to: string,
) {
  const change: OwnPathChange = {
    kind: "relocation",
    spacePath: normalizePath(spacePath),
    root: ownChangeRoot(from),
  };
  const root = ownChangeRoot(to);
  if (root === change.root) return;
  for (const watch of [...watches])
    if (watch.follower && follows(change, watch))
      watch.follower.follow(
        `${root}${normalizePath(watch.path).slice(change.root.length)}`,
      );
}

/**
 * Watches the Page file at `path` for deletions, renames and moves of this
 * Desktop that leave it: the watcher may report the path gone while such a
 * change runs or after it finished, or not at all. A deletion moves its root
 * away before removing it, and the watcher reports no event for a directory
 * moved away, so `onDeleted` tells when one that removes the Page has
 * finished. A `follower` saves the Page before a folder above it moves and
 * takes it to its new path after.
 */
export function watchOwnPathChange(
  spacePath: string,
  path: string,
  handlers: {
    onDeleted?: () => void;
    follower?: OwnRelocationFollower;
  } = {},
) {
  let left = false;
  const watch: PathWatch = {
    spacePath,
    path,
    follower: handlers.follower,
    finished: (change) => {
      if (!leavesPage(change, spacePath, path)) return;
      left = true;
      if (change.kind === "deletion") handlers.onDeleted?.();
    },
  };
  watches.add(watch);
  return {
    /** A change of this Desktop, running or finished, leaves the path. */
    changedHere: () =>
      left ||
      [...runningChanges].some((change) => leavesPage(change, spacePath, path)),
    stop: () => {
      watches.delete(watch);
    },
  };
}
