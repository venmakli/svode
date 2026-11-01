import * as m from "@/paraglide/messages.js";

import type {
  CollectionPropertyApplicability,
  CollectionPropertyDefinition,
  CollectionPropertyDisplay,
  CollectionStandardPropertySemantics,
  CommonCollectionPropertyId,
} from "./collection-property";
import type { PropertyOption } from "./types";

/**
 * What a Collection gives a common property: the value of its item and
 * whether it applies. Key, label, type, display, options, filter and sort
 * belong to the catalog.
 */
export interface CommonCollectionPropertyValue<Item> {
  getValue(item: Item): unknown;
  getAccessibilityLabel?(item: Item): string;
  getApplicability?(item: Item): CollectionPropertyApplicability;
}

const COMMON_PROPERTY_OWNERS: Readonly<
  Record<CommonCollectionPropertyId, string>
> = {
  agent: "agent-adapters",
  agents: "agent-adapters",
  space: "properties",
  state: "properties",
  title: "properties",
  updated: "properties",
};

/** The one label of a common property in every Collection. */
export function commonCollectionPropertyLabel(
  id: CommonCollectionPropertyId,
): string {
  switch (id) {
    case "title":
      return m.property_common_title();
    case "updated":
      return m.property_common_updated();
    case "agent":
      return m.property_common_agent();
    case "agents":
      return m.property_common_agents();
    case "state":
      return m.property_common_state();
    case "space":
      return m.property_common_space();
  }
}

/**
 * The catalog's builder of a common property. Only the catalog calls it:
 * the generic properties here and the agent properties of the agent
 * dictionary's owner; a Collection takes a built property.
 */
export function defineCommonCollectionProperty<Item>(
  id: CommonCollectionPropertyId,
  {
    display,
    label,
    standard,
    ...value
  }: CommonCollectionPropertyValue<Item> & {
    display?: CollectionPropertyDisplay<Item>;
    label?: string;
    standard: CollectionStandardPropertySemantics;
  },
): CollectionPropertyDefinition<Item> {
  return {
    ...value,
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    common: id,
    key: id,
    label: label ?? commonCollectionPropertyLabel(id),
    origin: "computed",
    owner: { featureId: COMMON_PROPERTY_OWNERS[id], kind: "feature" },
    semantics: display
      ? { display, kind: "standard", standard }
      : { kind: "standard", standard },
  };
}

/**
 * "Name": the item's name, in every Collection. The item's header shows it,
 * so the property panel does not repeat it. `label` is only the name a user
 * gave the title of a persisted Collection in its schema.
 */
export function defineTitleCollectionProperty<Item>({
  label,
  ...value
}: CommonCollectionPropertyValue<Item> & {
  label?: string | null;
}): CollectionPropertyDefinition<Item> {
  return defineCommonCollectionProperty("title", {
    ...value,
    label: label || undefined,
    standard: { type: "text" },
  });
}

/**
 * "Modified": when the item changed; the storage key of Pages stays
 * `updated`.
 */
export function defineUpdatedCollectionProperty<Item>(
  value: CommonCollectionPropertyValue<Item>,
): CollectionPropertyDefinition<Item> {
  return defineCommonCollectionProperty("updated", {
    ...value,
    standard: { display: "medium", type: "date" },
  });
}

/**
 * "Space": the name of the Space that owns the item, read-only; its options
 * are the Spaces of the set.
 */
export function defineSpaceCollectionProperty<Item>({
  getValue,
  items,
  ...value
}: Omit<CommonCollectionPropertyValue<Item>, "getValue"> & {
  getValue(item: Item): string | null;
  items: readonly Item[];
}): CollectionPropertyDefinition<Item> {
  const names = new Set<string>();
  for (const item of items) {
    const name = getValue(item);
    if (name) names.add(name);
  }
  const options: PropertyOption[] = [...names].map((name) => ({
    color: "neutral",
    name,
  }));
  return defineCommonCollectionProperty("space", {
    ...value,
    getValue,
    standard: { options, type: "select" },
  });
}
