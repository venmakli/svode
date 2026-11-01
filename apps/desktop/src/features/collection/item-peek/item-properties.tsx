import type { CollectionPropertyDefinition } from "@/features/properties";
import {
  CollectionPropertyPanel,
  type CollectionPropertyFactGroup,
} from "@/features/properties/panel";

import { readCollectionPresentationRuntime } from "../runtime/model/runtime";
import type { CollectionPresentationRuntime } from "../runtime/model/types";

/**
 * The properties of an open item: the property panel of its presentation's
 * properties, the same definitions as its columns, with the item's facts and
 * the editing its owner declared.
 */
export function CollectionItemProperties<Item>({
  factGroups,
  item,
  presentation,
}: {
  factGroups?: readonly CollectionPropertyFactGroup[];
  item: Item;
  presentation: CollectionPresentationRuntime;
}) {
  const { descriptor } =
    readCollectionPresentationRuntime(presentation).instance;
  return (
    <CollectionPropertyPanel
      factGroups={factGroups}
      item={item}
      properties={
        descriptor.properties as readonly CollectionPropertyDefinition<Item>[]
      }
    />
  );
}
