import type { CollectionPropertyConflictEntry } from "@/features/properties/panel";
import * as m from "@/paraglide/messages.js";

import {
  disputedPageMergeProperties,
  pageMergeDecisionValue,
  type PageMergeState,
} from "./page-merge";
import type { Page } from "./types";

/** The keys of a Page that its header shows, not its properties. */
const SYSTEM_KEYS = new Set(["title", "icon", "description", "cover"]);

function systemKeyLabel(key: string): string {
  switch (key) {
    case "title":
      return m.page_merge_key_title();
    case "icon":
      return m.page_merge_key_icon();
    case "description":
      return m.page_merge_key_description();
    case "cover":
      return m.page_merge_key_cover();
    default:
      return key;
  }
}

/** A value of the frontmatter as text, for a key without a property. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  return JSON.stringify(value);
}

function withValue(page: Page, key: string, value: unknown): Page {
  if (SYSTEM_KEYS.has(key)) {
    if (key === "title" && typeof value === "string")
      return { ...page, meta: { ...page.meta, title: value } };
    if (key === "icon")
      return {
        ...page,
        meta: { ...page.meta, icon: typeof value === "string" ? value : null },
      };
    if (key === "description")
      return {
        ...page,
        meta: {
          ...page.meta,
          description: typeof value === "string" ? value : undefined,
        },
      };
    return page;
  }
  const extra = { ...page.meta.extra };
  if (value === undefined) delete extra[key];
  else extra[key] = value;
  return { ...page, meta: { ...page.meta, extra } };
}

/**
 * The Page whose frontmatter is in conflict as its properties read until it
 * is written: the merged values and the decided values of disputed keys; a
 * disputed key without a decision has none.
 */
export function pageWithMerge(page: Page, state: PageMergeState): Page {
  if (state.merge.type !== "merged") return page;
  let merged: Page = { ...page, meta: { ...page.meta, extra: {} } };
  for (const property of state.merge.properties) {
    const decision = state.decisions[property.key];
    const value = property.disputed
      ? decision
        ? pageMergeDecisionValue(property, decision)
        : undefined
      : property.merged;
    merged = withValue(merged, property.key, value);
  }
  return merged;
}

/** The disputed properties of the Page as the conflict mode of its panel shows them. */
export function pageMergeEntries(
  page: Page,
  state: PageMergeState,
): CollectionPropertyConflictEntry<Page>[] {
  const merged = pageWithMerge(page, state);
  return disputedPageMergeProperties(state.merge).map((property) => {
    const decision = state.decisions[property.key] ?? null;
    const variant = (value: unknown) => ({
      item: withValue(merged, property.key, value),
      deleted: value === undefined,
      text: valueText(value),
    });
    return {
      key: property.key,
      label: systemKeyLabel(property.key),
      ours: variant(property.ours),
      theirs: variant(property.theirs),
      decision: decision?.type ?? null,
      decidedText: decision
        ? valueText(pageMergeDecisionValue(property, decision))
        : "",
    };
  });
}
