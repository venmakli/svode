import type { Entry } from "@/features/entry";

export function collectionEntriesTargetKey({
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

export function mergeStableEntriesByPath(current: Entry[], next: Entry[]) {
  if (current.length === 0) return next;

  const currentByPath = new Map(
    current.map((entry) => [entry.path, entry] as const),
  );
  let changed = current.length !== next.length;

  const merged = next.map((nextEntry, index) => {
    const currentEntry = currentByPath.get(nextEntry.path);
    if (!currentEntry || !sameEntry(currentEntry, nextEntry)) {
      changed = true;
      return nextEntry;
    }
    if (current[index] !== currentEntry) changed = true;
    return currentEntry;
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

function sameEntry(left: Entry, right: Entry) {
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
