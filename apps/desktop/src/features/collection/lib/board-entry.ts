import type { Entry } from "@/features/entry";
import type { Column } from "@/features/properties";
import { isEmptyValue } from "@/features/properties";

const NO_VALUE_KEY = "__no_value__";

export function noValueKey() {
  return NO_VALUE_KEY;
}

export function groupKeyForValue(value: unknown) {
  return isEmptyValue(value) ? NO_VALUE_KEY : String(value);
}

export function groupValueForKey(key: string) {
  return key === NO_VALUE_KEY ? null : key;
}

export function groupValue(entry: Entry, column: Column) {
  return entry.meta.extra?.[column.name] ?? null;
}

export function updateEntryGroupValue(
  entry: Entry,
  column: Column,
  value: string | null,
) {
  const extra = { ...entry.meta.extra };
  if (value === null) delete extra[column.name];
  else extra[column.name] = value;
  return {
    ...entry,
    meta: {
      ...entry.meta,
      extra,
    },
  };
}

export function reorderEntryAround(
  entries: Entry[],
  activePath: string,
  overPath: string,
  placement: "before" | "after",
) {
  if (activePath === overPath) return entries;
  const active = entries.find((entry) => entry.path === activePath);
  if (!active) return entries;
  const withoutActive = entries.filter((entry) => entry.path !== activePath);
  const insertAt = withoutActive.findIndex((entry) => entry.path === overPath);
  if (insertAt < 0) return entries;
  const offset = placement === "after" ? 1 : 0;
  return [
    ...withoutActive.slice(0, insertAt + offset),
    active,
    ...withoutActive.slice(insertAt + offset),
  ];
}
