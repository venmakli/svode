export interface ContentRelocation {
  from: string;
  to: string;
}

const README = /\/readme\.md$/i;

/**
 * Where the item a move took from `from` to `to` puts the open Page `path`:
 * the item itself, or the README of a folder moved by its directory or its
 * README. Pages further inside a moved folder follow the folder separately.
 */
export function relocatedItemPath(
  path: string,
  { from, to }: ContentRelocation,
): string | null {
  const root = from.replace(README, "");
  const readme = README.test(path) && path.replace(README, "") === root;
  if (path !== from && !readme) return null;
  // A README goes into the directory the folder has after the move; a folder
  // Page that became a leaf, or a leaf that became a folder Page, is `to`.
  if (path === from && !(readme && !/\.md$/i.test(to))) return to;
  return `${to.replace(README, "")}/${path.slice(root.length + 1)}`;
}
