import type { Page } from "@/features/page";
import { normalizePagePath } from "./utils";

export function entryParentDir(path: string) {
  const normalized = normalizePagePath(path).replace(/\/readme\.md$/i, ".md");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function entryCollectionPath(entry: Page) {
  return normalizePagePath(entry.path)
    .replace(/\/readme\.md$/i, "")
    .replace(/\.md$/i, "");
}

export function isFolderEntry(entry: Page) {
  return normalizePagePath(entry.path).toLowerCase().endsWith("/readme.md");
}

export function siblingEntries(entries: Page[], parentPath: string) {
  return entries.filter((entry) => entryParentDir(entry.path) === parentPath);
}

export function replaceSiblings(
  entries: Page[],
  parentPath: string,
  siblings: Page[],
) {
  const siblingPaths = new Set(siblings.map((entry) => entry.path));
  const next: Page[] = [];
  let inserted = false;

  for (const entry of entries) {
    if (entryParentDir(entry.path) !== parentPath) {
      next.push(entry);
      continue;
    }
    if (!inserted) {
      next.push(...siblings);
      inserted = true;
    }
    if (!siblingPaths.has(entry.path)) next.push(entry);
  }

  return inserted ? next : [...entries, ...siblings];
}

export function reorderVisibleEntries(
  all: Page[],
  visible: Page[],
  movedPath: string,
  toVisibleIndex: number,
) {
  const visiblePaths = new Set(visible.map((entry) => entry.path));
  if (!visiblePaths.has(movedPath)) return all;

  const next = all.filter((entry) => entry.path !== movedPath);
  const visibleWithoutMoved = all.filter(
    (entry) => visiblePaths.has(entry.path) && entry.path !== movedPath,
  );
  const anchor = visibleWithoutMoved[toVisibleIndex];
  const moved = all.find((entry) => entry.path === movedPath);
  if (!moved) return all;

  if (!anchor) return [...next, moved];
  const insertAt = next.findIndex((entry) => entry.path === anchor.path);
  if (insertAt < 0) return [...next, moved];
  return [...next.slice(0, insertAt), moved, ...next.slice(insertAt)];
}
