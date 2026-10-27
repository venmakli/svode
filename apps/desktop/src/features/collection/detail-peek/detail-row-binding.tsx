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
   * it, or shows it again in place of an editing form of the same selection
   * with the row actions it had. The next render shows the row's version of
   * the current ready state or closes the detail when the row is gone.
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
 * The binding follows only the request it showed last: while anything else
 * holds the peek, such as an editing form of the same row or a file opened
 * from the detail, or once the peek closed, it leaves the peek alone until
 * it opens a row again.
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
  // An open outside activation may come with the state that lists the row,
  // e.g. after creating it: the render with that state follows it.
  const [opened, setOpened] = useState(0);
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
      open: (row, selection, focusOptions) => {
        const previous = shown.current;
        const rowActions =
          previous &&
          collectionDetailSelectionEquals(previous.request.selection, selection)
            ? previous.rowActions
            : undefined;
        setOpened((count) => count + 1);
        return show(row, selection, rowActions, focusOptions);
      },
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
    // While another request holds the peek, the binding keeps the row's
    // actions for showing it again after a form of the same row.
    if (next) shown.current = { ...current, request: next };
    void controller.update(current.request, next).then((applied) => {
      if (applied && !next && shown.current === current) shown.current = null;
    });
  }, [controller, findRow, opened, request]);

  return binding;
}

/** The owner's detail of a row; the row actions of its presentation follow the owner's. */
function collectionDetailRequest(
  content: CollectionDetailContent,
  rowActions: ReactNode,
  selection: CollectionDetailSelection,
): CollectionDetailRequest {
  return {
    ...content,
    headerActions:
      content.headerActions || rowActions ? (
        <>
          {content.headerActions}
          {rowActions}
        </>
      ) : undefined,
    selection,
  };
}
