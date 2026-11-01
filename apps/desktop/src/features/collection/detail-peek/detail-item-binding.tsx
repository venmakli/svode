import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CollectionActivationContext } from "../runtime/model/types";
import { collectionDetailSelectionEquals } from "./detail-controller";
import type {
  CollectionDetailContent,
  CollectionDetailController,
  CollectionDetailFocusOptions,
  CollectionDetailRequest,
  CollectionDetailSelection,
} from "./types";

/**
 * Opens the read-only detail of an owner's items and keeps it on its item:
 * while it is open, every ready state of the owner's source shows the
 * current version of the item in place, and closes the detail when the item
 * is gone.
 */
export interface CollectionDetailItemBinding<Item> {
  /** The `onActivate` of a presentation whose items open the detail. */
  activation(target: {
    instanceKey: string;
    presentationId: string;
  }):
    | ((item: Item, context: CollectionActivationContext) => Promise<void>)
    | undefined;
  /**
   * Opens the detail of an item outside its presentation, e.g. after creating
   * it, or shows it again in place of an editing form of the same selection
   * with the item actions it had. The next render shows the item's version of
   * the current ready state or closes the detail when the item is gone.
   */
  open(
    item: Item,
    selection: CollectionDetailSelection,
    focusOptions?: CollectionDetailFocusOptions,
  ): Promise<boolean>;
}

interface ShownItemDetail<Item> {
  request: CollectionDetailRequest;
  itemActions?(item: Item): ReactNode;
}

/**
 * The binding follows only the request it showed last: while anything else
 * holds the peek, such as an editing form of the same item or a file opened
 * from the detail, or once the peek closed, it leaves the peek alone until
 * it opens an item again.
 */
export function useCollectionDetailItemBinding<Item>({
  controller,
  createContent,
  findItem,
}: {
  controller: CollectionDetailController | null;
  /**
   * The detail of an item; `binding` opens the nested items the detail lists,
   * such as a plugin's components, so that they follow the source too.
   * Changes with the inputs of the content and shows them in the open detail.
   */
  createContent(
    item: Item,
    binding: CollectionDetailItemBinding<Item>,
  ): CollectionDetailContent;
  /**
   * The current version of the item of a selection in the ready state of the
   * owner's own set of items, not the items a search leaves visible; undefined
   * when the set has no such item. Null while the source is not ready:
   * loading and refresh errors leave the shown detail as it is.
   */
  findItem: ((selection: CollectionDetailSelection) => Item | undefined) | null;
}): CollectionDetailItemBinding<Item> {
  const shown = useRef<ShownItemDetail<Item> | null>(null);
  // An open outside activation may come with the state that lists the item,
  // e.g. after creating it: the render with that state follows it.
  const [opened, setOpened] = useState(0);
  const { binding, request } = useMemo(() => {
    const request = (
      item: Item,
      selection: CollectionDetailSelection,
      itemActions: ((item: Item) => ReactNode) | undefined,
    ) =>
      collectionDetailRequest(
        createContent(item, binding),
        itemActions?.(item),
        selection,
      );
    const show = (
      item: Item,
      selection: CollectionDetailSelection,
      itemActions: ((item: Item) => ReactNode) | undefined,
      focusOptions: CollectionDetailFocusOptions | undefined,
    ) => {
      if (!controller) return Promise.resolve(false);
      const next = request(item, selection, itemActions);
      shown.current = { request: next, itemActions };
      return controller.open(next, focusOptions);
    };
    const binding: CollectionDetailItemBinding<Item> = {
      activation: ({ instanceKey, presentationId }) =>
        controller
          ? async (item, context) => {
              await show(
                item,
                { instanceKey, presentationId, itemId: context.itemId },
                context.actions,
                {
                  fallbackFocus: context.fallbackFocus,
                  returnFocus: context.returnFocus,
                },
              );
            }
          : undefined,
      open: (item, selection, focusOptions) => {
        const previous = shown.current;
        const itemActions =
          previous &&
          collectionDetailSelectionEquals(previous.request.selection, selection)
            ? previous.itemActions
            : undefined;
        setOpened((count) => count + 1);
        return show(item, selection, itemActions, focusOptions);
      },
    };
    return { binding, request };
  }, [controller, createContent]);

  useEffect(() => {
    const current = shown.current;
    if (!current || !controller || !findItem) return;
    const { selection } = current.request;
    const item = findItem(selection);
    const next =
      item === undefined ? null : request(item, selection, current.itemActions);
    // While another request holds the peek, the binding keeps the item's
    // actions for showing it again after a form of the same item.
    if (next) shown.current = { ...current, request: next };
    void controller.update(current.request, next).then((applied) => {
      if (applied && !next && shown.current === current) shown.current = null;
    });
  }, [controller, findItem, opened, request]);

  return binding;
}

/** The owner's detail of an item; the item actions of its presentation follow the owner's. */
function collectionDetailRequest(
  content: CollectionDetailContent,
  itemActions: ReactNode,
  selection: CollectionDetailSelection,
): CollectionDetailRequest {
  return {
    ...content,
    headerActions:
      content.headerActions || itemActions ? (
        <>
          {content.headerActions}
          {itemActions}
        </>
      ) : undefined,
    selection,
  };
}
