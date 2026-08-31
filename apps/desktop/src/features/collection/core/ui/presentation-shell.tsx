import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "@/shared/lib/utils";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";

import { collectionGalleryCardWidth } from "../../model/presentation-layout";
import {
  CollectionCardsShell,
  CollectionCardsSkeleton,
  CollectionListShell,
  CollectionListSkeleton,
} from "../../ui/presentation-layout";
import {
  createCollectionCorePresentationScope,
  resolveCollectionCoreFocusIndex,
} from "../lib/interaction";
import {
  applyCollectionCoreQuery,
  EMPTY_COLLECTION_CORE_QUERY,
} from "../model/query";
import { readCollectionCorePresentationRuntime } from "../model/runtime";
import type {
  CollectionCoreInteractionError,
  CollectionCorePresentationRuntime,
  CollectionCoreQueryState,
} from "../model/types";
import { CollectionCorePresentationItem } from "./presentation-item";
import {
  CollectionCoreBlockingError,
  CollectionCoreQueryEmpty,
  CollectionCoreReadySignals,
  CollectionCoreSourceEmpty,
} from "./presentation-states";

const cardGap = 14;
const emptyRows: readonly unknown[] = [];

interface CollectionCoreSelectionState {
  rowId: string;
  scope: string;
}

export interface CollectionCorePresentationShellProps {
  instanceKey: string;
  presentation: CollectionCorePresentationRuntime;
  className?: string;
  query: CollectionCoreQueryState;
  onQueryChange(query: CollectionCoreQueryState): void;
  onInteractionError?(error: CollectionCoreInteractionError): void;
}

export function CollectionCorePresentationShell({
  instanceKey,
  presentation,
  className,
  query,
  onQueryChange,
  onInteractionError,
}: CollectionCorePresentationShellProps) {
  const { instance } = readCollectionCorePresentationRuntime(presentation);
  const { descriptor, state } = instance;
  const cardWidth =
    descriptor.layout.kind === "gallery"
      ? collectionGalleryCardWidth(descriptor.layout.cardSize)
      : 1;
  const presentationScope = createCollectionCorePresentationScope(
    instanceKey,
    descriptor.id,
  );
  const [selection, setSelection] =
    useState<CollectionCoreSelectionState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const queryResult = useMemo(
    () =>
      state.phase === "ready"
        ? applyCollectionCoreQuery({
            descriptor,
            query,
            rows: state.rows,
          })
        : null,
    [descriptor, query, state],
  );
  const rows = queryResult?.rows ?? emptyRows;
  const rowIds = useMemo(
    () => rows.map((row) => descriptor.getRowId(row)),
    [descriptor, rows],
  );
  const selectedRowId =
    selection?.scope === presentationScope ? selection.rowId : null;
  const effectiveSelectedRowId =
    selectedRowId && rowIds.includes(selectedRowId) ? selectedRowId : null;
  const selectRow = useCallback(
    (rowId: string) =>
      setSelection((current) =>
        current?.scope === presentationScope && current.rowId === rowId
          ? current
          : { rowId, scope: presentationScope },
      ),
    [presentationScope],
  );

  const registerRow = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (element) {
        rowRefs.current.set(rowId, element);
      } else {
        rowRefs.current.delete(rowId);
      }
    },
    [],
  );

  const moveFocus = useCallback(
    (rowId: string, key: string) => {
      const currentIndex = rowIds.indexOf(rowId);
      const cardColumns =
        descriptor.layout.kind === "gallery"
          ? Math.max(
              1,
              Math.floor(
                ((cardsRef.current?.clientWidth ?? cardWidth) + cardGap) /
                  (cardWidth + cardGap),
              ),
            )
          : 1;
      const nextIndex = resolveCollectionCoreFocusIndex({
        cardColumns,
        currentIndex,
        itemCount: rowIds.length,
        key,
        renderer: descriptor.layout.kind,
      });
      if (nextIndex === null) {
        return;
      }
      const nextRowId = rowIds[nextIndex];
      if (!nextRowId) {
        return;
      }
      selectRow(nextRowId);
      rowRefs.current.get(nextRowId)?.focus();
    },
    [cardWidth, descriptor.layout.kind, rowIds, selectRow],
  );

  if (state.phase === "initial") {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        {state.skeleton ??
          (descriptor.layout.kind === "gallery" ? (
            <CollectionCardsSkeleton
              cardWidth={cardWidth}
              density={descriptor.layout.density}
              hasCover={Boolean(descriptor.layout.renderCover)}
            />
          ) : (
            <CollectionListSkeleton
              density={descriptor.layout.density ?? "comfortable"}
            />
          ))}
      </div>
    );
  }

  if (state.phase === "blocking_error") {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        <CollectionCoreBlockingError>{state.error}</CollectionCoreBlockingError>
      </div>
    );
  }

  const items = rows.map((row, index) => {
    const rowId = rowIds[index]!;
    const selected = effectiveSelectedRowId === rowId;
    return (
      <CollectionCorePresentationItem
        key={rowId}
        descriptor={descriptor}
        activationFocusFallback={() => surfaceRef.current}
        instanceKey={instanceKey}
        row={row}
        rowId={rowId}
        selected={selected}
        tabIndex={selected || (!effectiveSelectedRowId && index === 0) ? 0 : -1}
        onFocus={selectRow}
        onInteractionError={onInteractionError}
        onMoveFocus={moveFocus}
        registerRow={registerRow}
      />
    );
  });

  const sourceEmpty = queryResult?.sourceRows.length === 0;
  const queryEmpty = !sourceEmpty && rows.length === 0;
  return (
    <div
      ref={surfaceRef}
      className={cn(
        detailPageViewRowClassName,
        "flex flex-col gap-3",
        className,
      )}
      data-collection-core-surface
      tabIndex={-1}
    >
      <CollectionCoreReadySignals
        attention={state.attention}
        diagnostics={state.diagnostics}
      />
      {sourceEmpty ? (
        (state.sourceEmpty ?? <CollectionCoreSourceEmpty />)
      ) : queryEmpty ? (
        <CollectionCoreQueryEmpty
          onClear={() => onQueryChange(EMPTY_COLLECTION_CORE_QUERY)}
        />
      ) : descriptor.layout.kind === "gallery" ? (
        <CollectionCardsShell
          key={presentationScope}
          ref={cardsRef}
          cardWidth={cardWidth}
          role="list"
          aria-label={descriptor.label}
        >
          {items}
        </CollectionCardsShell>
      ) : (
        <CollectionListShell
          key={presentationScope}
          role="list"
          aria-label={descriptor.label}
        >
          {items}
        </CollectionListShell>
      )}
    </div>
  );
}
