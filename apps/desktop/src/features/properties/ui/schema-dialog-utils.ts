import { COLOR_NAMES, STATUS_GROUPS } from "../lib/utils";
import type { PropertyOption, PropertyType } from "../model/types";

export interface BaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

export function parseOptions(
  value: string,
  type: PropertyType,
): PropertyOption[] | undefined {
  const rows = value
    .split(/\n|,/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) return undefined;
  return rows.map((row) => {
    const [name, color, group] = row.split("|").map((part) => part.trim());
    return {
      name,
      color: COLOR_NAMES.includes(color as NonNullable<PropertyOption["color"]>)
        ? (color as NonNullable<PropertyOption["color"]>)
        : "neutral",
      group:
        type === "status"
          ? STATUS_GROUPS.some((item) => item.value === group)
            ? (group as PropertyOption["group"])
            : "todo"
          : undefined,
    };
  });
}
