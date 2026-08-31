import type { CollectionCoreActivationContext } from "../core/model/types";
import type {
  CollectionDetailContent,
  CollectionDetailController,
} from "./types";

export function createCollectionDetailActivation<Row>({
  controller,
  createContent,
  instanceKey,
  onRequested,
  presentationId,
}: {
  controller: CollectionDetailController | null;
  createContent(row: Row): CollectionDetailContent;
  instanceKey: string;
  onRequested?(rowId: string, row: Row): void;
  presentationId: string;
}):
  | ((row: Row, context: CollectionCoreActivationContext) => Promise<void>)
  | undefined {
  if (!controller) return undefined;

  return async (row, context) => {
    onRequested?.(context.rowId, row);
    const content = createContent(row);
    await controller.open(
      {
        ...content,
        headerActions:
          content.headerActions || context.actions ? (
            <>
              {content.headerActions}
              {context.actions}
            </>
          ) : undefined,
        selection: {
          instanceKey,
          presentationId,
          rowId: context.rowId,
        },
      },
      {
        fallbackFocus: context.fallbackFocus,
        returnFocus: context.returnFocus,
      },
    );
  };
}
