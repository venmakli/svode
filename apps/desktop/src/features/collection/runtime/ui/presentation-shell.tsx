import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PROPERTY_TYPE_ICONS,
  resolveStandardPropertyColumn,
} from "@/features/properties";
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
import { ColumnHeader } from "../../ui/table/table-shell";
import { defaultColumnWidth } from "../../ui/table/utils";
import {
  createCollectionPresentationScope,
  resolveCollectionFocusIndex,
} from "../lib/interaction";
import {
  applyCollectionQuery,
  collectionFilterOperators,
  EMPTY_COLLECTION_QUERY,
} from "../model/query";
import { readCollectionPresentationRuntime } from "../model/runtime";
import type {
  CollectionInteractionError,
  CollectionPresentationRuntime,
  CollectionQueryState,
} from "../model/types";
import { hasCollectionSort } from "./query-editor-parts";
import { CollectionPropertyQueryMenu } from "./query-editor";
import { CollectionPresentationItem } from "./presentation-item";
import {
  CollectionBlockingError,
  CollectionQueryEmpty,
  CollectionReadySignals,
  CollectionSourceEmpty,
} from "./presentation-states";

import { collectionVisibleItems } from "../model/hierarchy";

const cardGap = 14;
const emptyItems: readonly unknown[] = [];

interface CollectionSelectionState {
  itemId: string;
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
  const [openProperty, setOpenProperty] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const queryResult = useMemo(
    () =>
      state.phase === "ready"
        ? applyCollectionQuery({
            descriptor,
            query,
            items: state.items,
          })
        : null,
    [descriptor, query, state],
  );
  const visible = useMemo(
    () =>
      collectionVisibleItems(
        descriptor,
        queryResult?.items ?? emptyItems,
        query,
      ),
    [descriptor, queryResult, query],
  );
  const items = useMemo(() => visible.map((item) => item.item), [visible]);
  const previousVisible = useRef(visible);
  const focusedItem = useRef<string | null>(null);
  const resolveFallback = useCallback(
    (itemId: string) => {
      const item = previousVisible.current.find(
        (item) => descriptor.getItemId(item.item) === itemId,
      );
      for (const ancestor of [...(item?.ancestors ?? [])].reverse()) {
        const element = itemRefs.current.get(ancestor);
        if (element) return element;
      }
      return surfaceRef.current;
    },
    [descriptor],
  );
  useLayoutEffect(() => {
    const id = focusedItem.current;
    if (
      id &&
      !items.some((item) => descriptor.getItemId(item) === id) &&
      document.activeElement === document.body
    ) {
      resolveFallback(id)?.focus();
    }
    previousVisible.current = visible;
  }, [descriptor, resolveFallback, items, visible]);
  const itemIds = useMemo(
    () => items.map((item) => descriptor.getItemId(item)),
    [descriptor, items],
  );
  const selectedItemId =
    selection?.scope === presentationScope ? selection.itemId : null;
  const effectiveSelectedItemId =
    selectedItemId && itemIds.includes(selectedItemId) ? selectedItemId : null;
  const selectItem = useCallback(
    (itemId: string) =>
      setSelection((current) =>
        current?.scope === presentationScope && current.itemId === itemId
          ? current
          : { itemId, scope: presentationScope },
      ),
    [presentationScope],
  );

  const registerItem = useCallback(
    (itemId: string, element: HTMLElement | null) => {
      if (element) {
        itemRefs.current.set(itemId, element);
      } else {
        itemRefs.current.delete(itemId);
      }
    },
    [],
  );

  const moveFocus = useCallback(
    (itemId: string, key: string) => {
      const currentIndex = itemIds.indexOf(itemId);
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
        itemCount: itemIds.length,
        key,
        renderer: descriptor.layout.kind,
      });
      if (nextIndex === null) {
        return;
      }
      const nextItemId = itemIds[nextIndex];
      if (!nextItemId) {
        return;
      }
      selectItem(nextItemId);
      itemRefs.current.get(nextItemId)?.focus();
    },
    [cardWidth, descriptor.layout.kind, itemIds, selectItem],
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

  const itemNodes = items.map((item, index) => {
    const itemId = itemIds[index]!;
    const selected = effectiveSelectedItemId === itemId;
    const branch =
      descriptor.layout.kind === "table"
        ? descriptor.layout.hierarchy?.getBranch(item)
        : null;
    return (
      <Fragment key={itemId}>
        <CollectionPresentationItem
          descriptor={descriptor}
          activationFocusFallback={() => {
            for (const ancestor of [
              ...(visible[index]?.ancestors ?? []),
            ].reverse()) {
              const element = itemRefs.current.get(ancestor);
              if (element) return element;
            }
            return surfaceRef.current;
          }}
          depth={visible[index]?.ancestors.length ?? 0}
          instanceKey={instanceKey}
          item={item}
          itemId={itemId}
          selected={selected}
          tabIndex={
            selected || (!effectiveSelectedItemId && index === 0) ? 0 : -1
          }
          onFocus={(id) => {
            focusedItem.current = id;
            selectItem(id);
          }}
          onInteractionError={onInteractionError}
          onMoveFocus={moveFocus}
          registerItem={registerItem}
        />
        {branch?.expanded &&
        branch.status &&
        descriptor.layout.kind === "table" ? (
          <TableRow data-collection-branch-status={itemId}>
            <TableCell
              colSpan={
                descriptor.layout.visibleProperties.length +
                (descriptor.itemActions?.length ? 1 : 0)
              }
            >
              <div
                style={{
                  paddingInlineStart:
                    ((visible[index]?.ancestors.length ?? 0) + 1) * 20,
                }}
              >
                {branch.status}
              </div>
            </TableCell>
          </TableRow>
        ) : null}
      </Fragment>
    );
  });

  const sourceEmpty = queryResult?.sourceItems.length === 0;
  const queryEmpty = !sourceEmpty && items.length === 0;
  const tableLayout =
    descriptor.layout.kind === "table" ? descriptor.layout : null;
  return (
    <div
      ref={surfaceRef}
      className={cn(
        detailPageViewRowClassName,
        "flex flex-col gap-3",
        className,
      )}
      data-collection-surface
      onFocusCapture={(event) => {
        const itemElement = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-collection-row]",
        );
        focusedItem.current = itemElement?.dataset.collectionRow ?? null;
      }}
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
          {itemNodes}
        </CollectionCardsShell>
      ) : tableLayout ? (
        <CollectionTableShell>
          <Table
            key={presentationScope}
            className="min-w-full table-auto"
            aria-label={descriptor.label}
            style={{
              minWidth:
                tableLayout.visibleProperties.reduce(
                  (width, propertyKey) => {
                    const property = descriptor.properties.find(
                      (candidate) => candidate.key === propertyKey,
                    );
                    const column = property
                      ? resolveStandardPropertyColumn(property)
                      : null;
                    return (
                      width +
                      (propertyKey === tableLayout.primaryProperty
                        ? 260
                        : defaultColumnWidth(column ?? undefined))
                    );
                  },
                  descriptor.itemActions?.length ? 40 : 0,
                ) || "100%",
            }}
          >
            <TableHeader className="sticky top-0 z-10 bg-muted/40">
              <TableRow className="h-[34px] bg-muted/40 hover:bg-muted/40">
                {tableLayout.visibleProperties.map((propertyKey) => {
                  const property = descriptor.properties.find(
                    (candidate) => candidate.key === propertyKey,
                  );
                  const column = property
                    ? resolveStandardPropertyColumn(property)
                    : null;
                  const Icon = PROPERTY_TYPE_ICONS[column?.type ?? "text"];
                  const queryEnabled = Boolean(
                    property &&
                    (collectionFilterOperators(property).length > 0 ||
                      hasCollectionSort(property)),
                  );
                  return (
                    <TableHead
                      key={propertyKey}
                      className="h-[34px] border-r p-0"
                      style={{
                        width:
                          propertyKey === tableLayout.primaryProperty
                            ? 260
                            : defaultColumnWidth(column ?? undefined),
                      }}
                    >
                      <ColumnHeader
                        readOnly={!queryEnabled}
                        label={property?.label ?? propertyKey}
                        icon={Icon}
                        open={openProperty === propertyKey}
                        onOpenChange={(open) =>
                          setOpenProperty(open ? propertyKey : null)
                        }
                      >
                        {queryEnabled ? (
                          <CollectionPropertyQueryMenu
                            open={openProperty === propertyKey}
                            presentation={presentation}
                            propertyKey={propertyKey}
                            trigger={<span />}
                            value={query}
                            onChange={onQueryChange}
                            onOpenChange={(open) =>
                              setOpenProperty(open ? propertyKey : null)
                            }
                          />
                        ) : (
                          <span />
                        )}
                      </ColumnHeader>
                    </TableHead>
                  );
                })}
                {descriptor.itemActions?.length ? (
                  <TableHead className="h-[34px] w-10 p-0" />
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>{itemNodes}</TableBody>
          </Table>
        </CollectionTableShell>
      ) : (
        <CollectionListShell
          key={presentationScope}
          role="list"
          aria-label={descriptor.label}
        >
          {itemNodes}
        </CollectionListShell>
      )}
    </div>
  );
}
