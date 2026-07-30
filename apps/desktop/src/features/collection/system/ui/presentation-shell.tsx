import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "@/shared/lib/utils";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";

import {
  CollectionCardsShell,
  CollectionCardsSkeleton,
  CollectionListShell,
  CollectionListSkeleton,
} from "../../ui/presentation-layout";
import {
  createSystemCollectionPresentationScope,
  resolveSystemCollectionFocusIndex,
} from "../lib/interaction";
import { readSystemCollectionPresentationRuntime } from "../model/runtime";
import type {
  SystemCollectionDetailController,
  SystemCollectionInteractionError,
  SystemCollectionPresentationRuntime,
} from "../model/types";
import { SystemCollectionPresentationItem } from "./presentation-item";

const defaultCardWidth = 224;
const cardGap = 14;
const emptyRows: readonly unknown[] = [];

interface SystemCollectionSelectionState {
  rowId: string;
  scope: string;
}

export interface SystemCollectionPresentationShellProps {
  instanceKey: string;
  presentation: SystemCollectionPresentationRuntime;
  cardWidth?: number;
  className?: string;
  density?: "compact" | "comfortable";
  detailController?: SystemCollectionDetailController;
  onInteractionError?(error: SystemCollectionInteractionError): void;
}

export function SystemCollectionPresentationShell({
  instanceKey,
  presentation,
  cardWidth = defaultCardWidth,
  className,
  density = "comfortable",
  detailController,
  onInteractionError,
}: SystemCollectionPresentationShellProps) {
  const { instance } = readSystemCollectionPresentationRuntime(presentation);
  const { descriptor, state } = instance;
  const presentationScope = createSystemCollectionPresentationScope(
    instanceKey,
    descriptor.id,
  );
  const [selection, setSelection] =
    useState<SystemCollectionSelectionState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const cardsRef = useRef<HTMLDivElement | null>(null);

  const rows = state.phase === "ready" ? state.rows : emptyRows;
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
        descriptor.renderer === "cards"
          ? Math.max(
              1,
              Math.floor(
                ((cardsRef.current?.clientWidth ?? cardWidth) + cardGap) /
                  (cardWidth + cardGap),
              ),
            )
          : 1;
      const nextIndex = resolveSystemCollectionFocusIndex({
        cardColumns,
        currentIndex,
        itemCount: rowIds.length,
        key,
        renderer: descriptor.renderer,
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
    [cardWidth, descriptor.renderer, rowIds, selectRow],
  );

  if (state.phase === "initial") {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        {state.skeleton ??
          (descriptor.renderer === "cards" ? (
            <CollectionCardsSkeleton cardWidth={cardWidth} />
          ) : (
            <CollectionListSkeleton density={density} />
          ))}
      </div>
    );
  }

  if (state.phase === "blocking_error") {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        <div
          role="alert"
          className="text-sm text-destructive"
          data-system-collection-diagnostic
        >
          {state.error}
        </div>
      </div>
    );
  }

  if (rows.length === 0 && state.sourceEmpty) {
    return (
      <div className={cn(detailPageViewRowClassName, className)}>
        {state.sourceEmpty}
      </div>
    );
  }

  const items = rows.map((row, index) => {
    const rowId = rowIds[index]!;
    const selected = effectiveSelectedRowId === rowId;
    return (
      <SystemCollectionPresentationItem
        key={rowId}
        descriptor={descriptor}
        detailController={detailController}
        density={density}
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

  return (
    <div className={cn(detailPageViewRowClassName, className)}>
      {descriptor.renderer === "cards" ? (
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
