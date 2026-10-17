/**
 * Content deletions started in this Desktop, so an open Page whose file goes
 * away tells them from a deletion by another writer.
 */
interface OwnDeletion {
  spacePath: string;
  /** What the deletion removes: the path, or the directory of its README. */
  root: string;
}

const runningDeletions = new Set<OwnDeletion>();
const finishedListeners = new Set<(deletion: OwnDeletion) => void>();

function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/g, "");
}

// Like the core delete: a nested README.md stands for its whole directory.
function deletionRoot(path: string) {
  const normalized = normalizePath(path);
  return /^(.+)\/readme\.md$/i.exec(normalized)?.[1] ?? normalized;
}

function removesPage(deletion: OwnDeletion, spacePath: string, path: string) {
  if (deletion.spacePath !== normalizePath(spacePath)) return false;
  const page = normalizePath(path);
  return page === deletion.root || page.startsWith(`${deletion.root}/`);
}

/** Runs a content deletion of this Desktop, known to open Pages it removes. */
export async function trackOwnContentDeletion<T>(
  target: { spacePath: string; path: string },
  run: () => Promise<T>,
): Promise<T> {
  const deletion = {
    spacePath: normalizePath(target.spacePath),
    root: deletionRoot(target.path),
  };
  runningDeletions.add(deletion);
  try {
    const result = await run();
    for (const listener of finishedListeners) listener(deletion);
    return result;
  } finally {
    runningDeletions.delete(deletion);
  }
}

/**
 * Watches the Page file at `path` for deletions of this Desktop: the watcher
 * may report the file gone while such a deletion runs or after it finished.
 */
export function watchOwnPageDeletion(spacePath: string, path: string) {
  let finished = false;
  const listener = (deletion: OwnDeletion) => {
    if (removesPage(deletion, spacePath, path)) finished = true;
  };
  finishedListeners.add(listener);
  return {
    deletedHere: () =>
      finished ||
      [...runningDeletions].some((deletion) =>
        removesPage(deletion, spacePath, path),
      ),
    stop: () => {
      finishedListeners.delete(listener);
    },
  };
}
