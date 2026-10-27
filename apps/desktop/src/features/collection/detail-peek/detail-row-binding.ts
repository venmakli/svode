import { useEffect, useMemo, useRef, type ReactNode } from "react";

import type { CollectionActivationContext } from "../runtime/model/types";
import { collectionDetailRequest } from "./detail-activation";
import type {
  CollectionDetailContent,
  CollectionDetailController,
  CollectionDetailFocusOptions,
  CollectionDetailRequest,
  CollectionDetailSelection,
} from "./types";

/**
 * Opens the read-only detail of an owner's rows and keeps it on its row:
 * while it is open, every ready state of the owner's source shows the
 * current version of the row in place, and closes the detail when the row
 * is gone.
 */
export interface CollectionDetailRowBinding<Row> {
  /** The `onActivate` of a presentation whose rows open the detail. */
  activation(target: {
    instanceKey: string;
    presentationId: string;
  }):
    | ((row: Row, context: CollectionActivationContext) => Promise<void>)
    | undefined;
  /**
   * Opens the detail of a row outside its presentation, e.g. after creating
   * it, or shows it again in place of an editing form of the same selection.
   */
  open(
    row: Row,
    selection: CollectionDetailSelection,
    focusOptions?: CollectionDetailFocusOptions,
  ): Promise<boolean>;
}

interface ShownRowDetail<Row> {
  request: CollectionDetailRequest;
  rowActions?(row: Row): ReactNode;
}

/**
 * The binding follows only the request it showed last: once anything else
 * takes the peek, such as an editing form of the same row or a file opened
 * from the detail, or the peek closes, it leaves the peek alone until it
 * opens a row again.
 */
export function useCollectionDetailRowBinding<Row>({
  controller,
  createContent,
  findRow,
}: {
  controller: CollectionDetailController | null;
  /**
   * The detail of a row; `binding` opens the nested rows the detail lists,
   * such as a plugin's components, so that they follow the source too.
   * Changes with the inputs of the content and shows them in the open detail.
   */
  createContent(
    row: Row,
    binding: CollectionDetailRowBinding<Row>,
  ): CollectionDetailContent;
  /**
   * The current version of the row of a selection in the ready state of the
   * owner's own set of rows, not the rows a search leaves visible; undefined
   * when the set has no such row. Null while the source is not ready:
   * loading and refresh errors leave the shown detail as it is.
   */
  findRow: ((selection: CollectionDetailSelection) => Row | undefined) | null;
}): CollectionDetailRowBinding<Row> {
  const shown = useRef<ShownRowDetail<Row> | null>(null);
  const { binding, request } = useMemo(() => {
    const request = (
      row: Row,
      selection: CollectionDetailSelection,
      rowActions: ((row: Row) => ReactNode) | undefined,
    ) =>
      collectionDetailRequest(
        createContent(row, binding),
        rowActions?.(row),
        selection,
      );
    const show = (
      row: Row,
      selection: CollectionDetailSelection,
      rowActions: ((row: Row) => ReactNode) | undefined,
      focusOptions: CollectionDetailFocusOptions | undefined,
    ) => {
      if (!controller) return Promise.resolve(false);
      const next = request(row, selection, rowActions);
      shown.current = { request: next, rowActions };
      return controller.open(next, focusOptions);
    };
    const binding: CollectionDetailRowBinding<Row> = {
      activation: ({ instanceKey, presentationId }) =>
        controller
          ? async (row, context) => {
              await show(
                row,
                { instanceKey, presentationId, rowId: context.rowId },
                context.actions,
                {
                  fallbackFocus: context.fallbackFocus,
                  returnFocus: context.returnFocus,
                },
              );
            }
          : undefined,
      open: (row, selection, focusOptions) =>
        show(row, selection, undefined, focusOptions),
    };
    return { binding, request };
  }, [controller, createContent]);

  useEffect(() => {
    const current = shown.current;
    if (!current || !controller || !findRow) return;
    const { selection } = current.request;
    const row = findRow(selection);
    const next =
      row === undefined ? null : request(row, selection, current.rowActions);
    const following = next ? { ...current, request: next } : null;
    shown.current = following;
    void controller.update(current.request, next).then((applied) => {
      if (!applied && shown.current === following) shown.current = null;
    });
  }, [controller, findRow, request]);

  return binding;
}
