import type { Page } from "@/features/page";

export function collectionItemsTargetKey({
  collectionPath,
  projectPath,
  spacePath,
}: {
  collectionPath: string;
  projectPath?: string | null;
  spacePath: string;
}) {
  return [spacePath, projectPath ?? "", collectionPath].join("\u0000");
}

export function mergeStableItemsByPath(current: Page[], next: Page[]) {
  if (current.length === 0) return next;

  const currentByPath = new Map(
    current.map((item) => [item.path, item] as const),
  );
  let changed = current.length !== next.length;

  const merged = next.map((nextItem, index) => {
    const currentItem = currentByPath.get(nextItem.path);
    if (!currentItem || !sameItem(currentItem, nextItem)) {
      changed = true;
      return nextItem;
    }
    if (current[index] !== currentItem) changed = true;
    return currentItem;
  });

  return changed ? merged : current;
}

export function sameStringSet(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function rebaseCollectionItems(
  items: Page[],
  previousCollectionPath: string,
  collectionPath: string,
) {
  let changed = false;
  const next = items.map((item) => {
    const path = rebaseCollectionPath(
      item.path,
      previousCollectionPath,
      collectionPath,
    );
    if (path === item.path) return item;
    changed = true;
    return { ...item, path };
  });
  return changed ? next : items;
}

export function rebaseCollectionPathSet(
  paths: Set<string>,
  previousCollectionPath: string,
  collectionPath: string,
) {
  const next = new Set(
    Array.from(paths, (path) =>
      rebaseCollectionPath(path, previousCollectionPath, collectionPath),
    ),
  );
  return sameStringSet(paths, next) ? paths : next;
}

export function rebaseCollectionPath(
  path: string,
  previousCollectionPath: string,
  collectionPath: string,
) {
  if (path === previousCollectionPath) return collectionPath;
  const prefix = `${previousCollectionPath}/`;
  return path.startsWith(prefix)
    ? `${collectionPath}/${path.slice(prefix.length)}`
    : path;
}

function sameItem(left: Page, right: Page) {
  return (
    left.path === right.path &&
    left.body === right.body &&
    sameJsonValue(left.meta, right.meta) &&
    sameJsonValue(left.warnings ?? null, right.warnings ?? null)
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object") return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      sameJsonValue(leftRecord[key], rightRecord[key]),
  );
}
