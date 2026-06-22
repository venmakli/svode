import {
  ENTRY_FIELD_TEXT_SAVE_DELAY_MS,
  type EntryFieldSavePolicy,
} from "@/features/entry";
import type { Column, PropertyType } from "./types";

export function propertyFieldSavePolicy(
  column: Pick<Column, "type">,
): EntryFieldSavePolicy {
  return isTextLikePropertyType(column.type)
    ? { mode: "debounced", delayMs: ENTRY_FIELD_TEXT_SAVE_DELAY_MS }
    : { mode: "immediate" };
}

export function isTextLikePropertyType(type: PropertyType) {
  return type === "text" || type === "number";
}
