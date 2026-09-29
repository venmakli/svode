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
