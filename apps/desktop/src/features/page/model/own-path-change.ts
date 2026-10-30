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

const runningChanges = new Set<OwnPathChange>();
const finishedListeners = new Set<(change: OwnPathChange) => void>();

function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/g, "");
}

// Like the core delete and rename: a nested README.md stands for its whole
// directory.
function changeRoot(path: string) {
  const normalized = normalizePath(path);
  return /^(.+)\/readme\.md$/i.exec(normalized)?.[1] ?? normalized;
}

function leavesPage(change: OwnPathChange, spacePath: string, path: string) {
  if (change.spacePath !== normalizePath(spacePath)) return false;
  const page = normalizePath(path);
  return page === change.root || page.startsWith(`${change.root}/`);
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
    root: changeRoot(target.path),
  };
  runningChanges.add(change);
  try {
    const result = await run();
    if (leftPath(result))
      for (const listener of finishedListeners) listener(change);
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
 * path it leaves. `leftPath` tells whether the finished one left it: a title
 * rename keeps the path when the file name stays.
 */
export function trackOwnContentRelocation<T>(
  target: { spacePath: string; path: string },
  run: () => Promise<T>,
  leftPath: (result: T) => boolean = () => true,
): Promise<T> {
  return trackOwnPathChange("relocation", target, run, leftPath);
}

/**
 * Watches the Page file at `path` for deletions, renames and moves of this
 * Desktop that leave it: the watcher may report the path gone while such a
 * change runs or after it finished, or not at all. A deletion moves its root
 * away before removing it, and the watcher reports no event for a directory
 * moved away, so `onDeleted` tells when one that removes the Page has
 * finished.
 */
export function watchOwnPathChange(
  spacePath: string,
  path: string,
  onDeleted?: () => void,
) {
  let left = false;
  const listener = (change: OwnPathChange) => {
    if (!leavesPage(change, spacePath, path)) return;
    left = true;
    if (change.kind === "deletion") onDeleted?.();
  };
  finishedListeners.add(listener);
  return {
    /** A change of this Desktop, running or finished, leaves the path. */
    changedHere: () =>
      left ||
      [...runningChanges].some((change) => leavesPage(change, spacePath, path)),
    stop: () => {
      finishedListeners.delete(listener);
    },
  };
}
