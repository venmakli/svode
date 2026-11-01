import { applyCollectionQuery } from "./query";
import type {
  CollectionPresentationDescriptor,
  CollectionQueryState,
} from "./types";

export interface CollectionVisibleItem<Item> {
  item: Item;
  ancestors: readonly string[];
}

export function collectionVisibleItems<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
  roots: readonly Item[],
  query: CollectionQueryState,
): CollectionVisibleItem<Item>[] {
  const hierarchy =
    descriptor.layout.kind === "table"
      ? descriptor.layout.hierarchy
      : undefined;
  const result: CollectionVisibleItem<Item>[] = [];
  const visit = (items: readonly Item[], ancestors: readonly string[]) => {
    for (const item of items) {
      const id = descriptor.getItemId(item);
      if (ancestors.includes(id)) continue;
      result.push({ item, ancestors });
      const branch = hierarchy?.getBranch(item);
      if (branch?.expanded) {
        const children = applyCollectionQuery({
          descriptor,
          items: branch.items,
          query: { ...query, search: "", filters: [] },
        }).items;
        visit(children, [...ancestors, id]);
      }
    }
  };
  visit(roots, []);
  return result;
}
