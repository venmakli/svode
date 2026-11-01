import type { Page } from "@/features/page";
import { normalizePagePath } from "./utils";

export function itemParentDir(path: string) {
  const normalized = normalizePagePath(path).replace(/\/readme\.md$/i, ".md");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function itemCollectionPath(item: Page) {
  return normalizePagePath(item.path)
    .replace(/\/readme\.md$/i, "")
    .replace(/\.md$/i, "");
}

export function isFolderItem(item: Page) {
  return normalizePagePath(item.path).toLowerCase().endsWith("/readme.md");
}

export function siblingItems(items: Page[], parentPath: string) {
  return items.filter((item) => itemParentDir(item.path) === parentPath);
}

export function replaceSiblings(
  items: Page[],
  parentPath: string,
  siblings: Page[],
) {
  const siblingPaths = new Set(siblings.map((item) => item.path));
  const next: Page[] = [];
  let inserted = false;

  for (const item of items) {
    if (itemParentDir(item.path) !== parentPath) {
      next.push(item);
      continue;
    }
    if (!inserted) {
      next.push(...siblings);
      inserted = true;
    }
    if (!siblingPaths.has(item.path)) next.push(item);
  }

  return inserted ? next : [...items, ...siblings];
}

export function reorderVisibleItems(
  all: Page[],
  visible: Page[],
  movedPath: string,
  toVisibleIndex: number,
) {
  const visiblePaths = new Set(visible.map((item) => item.path));
  if (!visiblePaths.has(movedPath)) return all;

  const next = all.filter((item) => item.path !== movedPath);
  const visibleWithoutMoved = all.filter(
    (item) => visiblePaths.has(item.path) && item.path !== movedPath,
  );
  const anchor = visibleWithoutMoved[toVisibleIndex];
  const moved = all.find((item) => item.path === movedPath);
  if (!moved) return all;

  if (!anchor) return [...next, moved];
  const insertAt = next.findIndex((item) => item.path === anchor.path);
  if (insertAt < 0) return [...next, moved];
  return [...next.slice(0, insertAt), moved, ...next.slice(insertAt)];
}
