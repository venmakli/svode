import type { ReactNode } from "react";

import type { CollectionActivationContext } from "../runtime/model/types";
import type {
  CollectionDetailContent,
  CollectionDetailController,
  CollectionDetailRequest,
  CollectionDetailSelection,
} from "./types";

export function createCollectionDetailActivation<Row>({
  controller,
  createContent,
  instanceKey,
  presentationId,
}: {
  controller: CollectionDetailController | null;
  createContent(row: Row): CollectionDetailContent;
  instanceKey: string;
  presentationId: string;
}):
  | ((row: Row, context: CollectionActivationContext) => Promise<void>)
  | undefined {
  if (!controller) return undefined;

  return async (row, context) => {
    await controller.open(
      collectionDetailRequest(createContent(row), context.actions?.(row), {
        instanceKey,
        presentationId,
        rowId: context.rowId,
      }),
      {
        fallbackFocus: context.fallbackFocus,
        returnFocus: context.returnFocus,
      },
    );
  };
}

/** The owner's detail of a row; the row actions of its presentation follow the owner's. */
export function collectionDetailRequest(
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
