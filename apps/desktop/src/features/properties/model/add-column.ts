import type { Column, PropertyType } from "./types";

// Core allows at most one column of each of these types per collection.
const SINGLE_COLUMN_TYPES: ReadonlySet<PropertyType> = new Set([
  "status",
  "unique_id",
]);

export function isPropertyTypeAddable(
  columns: readonly Column[],
  type: PropertyType,
) {
  return (
    !SINGLE_COLUMN_TYPES.has(type) ||
    !columns.some((column) => column.type === type)
  );
}

/** The base name, or the base name with the first free number from 2. */
export function uniquePropertyName(
  columns: readonly Column[],
  baseName: string,
) {
  const names = new Set(columns.map((column) => column.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}
