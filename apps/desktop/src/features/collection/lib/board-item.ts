import type { Page } from "@/features/page";
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

export function groupValue(item: Page, column: Column) {
  return item.meta.extra?.[column.name] ?? null;
}

export function updateItemGroupValue(
  item: Page,
  column: Column,
  value: string | null,
) {
  const extra = { ...item.meta.extra };
  if (value === null) delete extra[column.name];
  else extra[column.name] = value;
  return {
    ...item,
    meta: {
      ...item.meta,
      extra,
    },
  };
}

export function reorderItemAround(
  items: Page[],
  activePath: string,
  overPath: string,
  placement: "before" | "after",
) {
  if (activePath === overPath) return items;
  const active = items.find((item) => item.path === activePath);
  if (!active) return items;
  const withoutActive = items.filter((item) => item.path !== activePath);
  const insertAt = withoutActive.findIndex((item) => item.path === overPath);
  if (insertAt < 0) return items;
  const offset = placement === "after" ? 1 : 0;
  return [
    ...withoutActive.slice(0, insertAt + offset),
    active,
    ...withoutActive.slice(insertAt + offset),
  ];
}
