import { readCollectionPresentationRuntime } from "../runtime/model/runtime";
import type { CollectionPresentationRuntime } from "../runtime/model/types";
import {
  CollectionItemActionsDropdownMenu,
  visibleItemActions,
} from "../runtime/ui/item-actions";

const keepRejectionInMenu = () => undefined;

/**
 * ⋯ of an open item: the item actions of its presentation for the item's
 * current version, however the item was opened; nothing when none is
 * visible. A refused action stays open in the menu with its reason.
 */
export function CollectionItemActionsMenu<Item>({
  item,
  presentation,
}: {
  item: Item;
  presentation: CollectionPresentationRuntime;
}) {
  const { descriptor } =
    readCollectionPresentationRuntime(presentation).instance;
  const actions = visibleItemActions(descriptor.itemActions, item);
  return (
    <CollectionItemActionsDropdownMenu
      actions={actions}
      item={item}
      onRejected={keepRejectionInMenu}
    />
  );
}
