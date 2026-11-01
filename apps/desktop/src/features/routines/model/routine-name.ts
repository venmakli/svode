import type { RoutineItem } from "./types";

const UNICODE_WHITESPACE = /\p{White_Space}+/gu;

export function routineNameKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(UNICODE_WHITESPACE, " ")
    .toLowerCase()
    .normalize("NFKC");
}

export function findRoutineNameConflictPath(
  name: string,
  items: readonly RoutineItem[],
  excludeItemId?: string,
) {
  const key = routineNameKey(name);
  return (
    items.find(
      (item) => item.id !== excludeItemId && routineNameKey(item.name) === key,
    )?.definitionPath ?? null
  );
}
