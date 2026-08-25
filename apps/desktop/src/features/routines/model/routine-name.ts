import type { RoutineRow } from "./types";

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
  rows: readonly RoutineRow[],
  excludeRowId?: string,
) {
  const key = routineNameKey(name);
  return (
    rows.find(
      (row) => row.id !== excludeRowId && routineNameKey(row.name) === key,
    )?.definitionPath ?? null
  );
}
