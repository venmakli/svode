import { useCallback, useMemo, useRef, useState } from "react";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";

import { collectionGalleryCardWidth } from "../../model/presentation-layout";
import {
  CollectionCardsShell,
  CollectionCardsSkeleton,
  CollectionListShell,
  CollectionListSkeleton,
} from "../../ui/presentation-layout";
import { CollectionTableShell } from "../../ui/table/table-presentation";
import {
  createCollectionPresentationScope,
  resolveCollectionFocusIndex,
} from "../lib/interaction";
import { applyCollectionQuery, EMPTY_COLLECTION_QUERY } from "../model/query";
import { readCollectionPresentationRuntime } from "../model/runtime";
import type {
  CollectionInteractionError,
  CollectionPresentationRuntime,
  CollectionQueryState,
} from "../model/types";
import { CollectionPresentationItem } from "./presentation-item";
import {
  CollectionBlockingError,
  CollectionQueryEmpty,
  CollectionReadySignals,
  CollectionSourceEmpty,
} from "./presentation-states";

const cardGap = 14;
const emptyRows: readonly unknown[] = [];

interface CollectionSelectionState {
  rowId: string;
  scope: string;
}

export interface CollectionPresentationShellProps {
  instanceKey: string;
  presentation: CollectionPresentationRuntime;
  className?: string;
  query: CollectionQueryState;
  onQueryChange(query: CollectionQueryState): void;
  onInteractionError?(error: CollectionInteractionError): void;
}

export function CollectionPresentationShell({
  instanceKey,
  presentation,
  className,
  query,
  onQueryChange,
  onInteractionError,
}: CollectionPresentationShellProps) {
  const { instance } = readCollectionPresentationRuntime(presentation);
  const { descriptor, state } = instance;
  const cardWidth =
    descriptor.layout.kind === "gallery"
      ? collectionGalleryCardWidth(descriptor.layout.cardSize)
      : 1;
  const presentationScope = createCollectionPresentationScope(
    instanceKey,
    descriptor.id,
  );
  const [selection, setSelection] = useState<CollectionSelectionState | null>(
    null,
  );
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const queryResult = useMemo(
    () =>
      state.phase === "ready"
        ? applyCollectionQuery({
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
      const nextIndex = resolveCollectionFocusIndex({
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
              density={
                descriptor.layout.kind === "table"
                  ? (descriptor.layout.density ?? "comfortable")
                  : "comfortable"
              }
            />
          ))}
      </div>
    );
  }

  if (state.phase === "blocking_error") {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        <CollectionBlockingError>{state.error}</CollectionBlockingError>
      </div>
    );
  }

  if (
    descriptor.layout.kind === "board" ||
    descriptor.layout.kind === "calendar"
  ) {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        <CollectionBlockingError>
          {m.collection_persisted_capabilities_required()}
        </CollectionBlockingError>
      </div>
    );
  }

  const items = rows.map((row, index) => {
    const rowId = rowIds[index]!;
    const selected = effectiveSelectedRowId === rowId;
    return (
      <CollectionPresentationItem
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
      data-collection-surface
      tabIndex={-1}
    >
      <CollectionReadySignals
        attention={state.attention}
        diagnostics={state.diagnostics}
      />
      {sourceEmpty ? (
        (state.sourceEmpty ?? <CollectionSourceEmpty />)
      ) : queryEmpty ? (
        <CollectionQueryEmpty
          onClear={() => onQueryChange(EMPTY_COLLECTION_QUERY)}
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
      ) : descriptor.layout.kind === "table" ? (
        <CollectionTableShell>
          <Table
            key={presentationScope}
            className="min-w-full table-auto"
            aria-label={descriptor.label}
          >
            <TableHeader>
              <TableRow className="h-[34px] bg-muted/40 hover:bg-muted/40">
                {descriptor.layout.visibleProperties.map((propertyKey) => (
                  <TableHead key={propertyKey} className="h-[34px]">
                    {descriptor.properties.find(
                      (property) => property.key === propertyKey,
                    )?.label ?? propertyKey}
                  </TableHead>
                ))}
                {descriptor.rowActions?.length ? (
                  <TableHead className="h-[34px] w-10" />
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>{items}</TableBody>
          </Table>
        </CollectionTableShell>
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
