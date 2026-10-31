/** A file in conflict, relative to `spacePath`, a Space or repository. */
export interface ConflictFileTarget {
  spacePath: string;
  path: string;
}

/**
 * Where a conflicted path is resolved (1.F): a Page in its editor, any other
 * file in "Changes". The app shell owns both surfaces.
 */
export interface ConflictNavigation {
  openFile: (target: ConflictFileTarget) => void;
  openPage: (target: ConflictFileTarget) => void;
}

let navigation: ConflictNavigation | null = null;

/** The app shell opens the place a conflicted path is resolved in. */
export function registerConflictNavigation(next: ConflictNavigation) {
  navigation = next;
  return () => {
    if (navigation === next) navigation = null;
  };
}

/** Opens "Changes" at a conflicted file, when the app shell can. */
export function conflictFileOpener(target: ConflictFileTarget | null) {
  if (!navigation || !target) return undefined;
  return () => navigation?.openFile(target);
}

/** Opens a conflicted Page in its editor, when the app shell can. */
export function conflictPageOpener(target: ConflictFileTarget | null) {
  if (!navigation || !target) return undefined;
  return () => navigation?.openPage(target);
}
