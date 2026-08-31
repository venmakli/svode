import {
  PAGE_FIELD_TEXT_SAVE_DELAY_MS,
  type PageFieldSavePolicy,
} from "./field-save";
import type { Column, PropertyType } from "@/features/properties";

export function propertyFieldSavePolicy(
  column: Pick<Column, "type">,
): PageFieldSavePolicy {
  return isTextLikePropertyType(column.type)
    ? { mode: "debounced", delayMs: PAGE_FIELD_TEXT_SAVE_DELAY_MS }
    : { mode: "immediate" };
}

export function isTextLikePropertyType(type: PropertyType) {
  return type === "text" || type === "number";
}
