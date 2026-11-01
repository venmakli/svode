import type { RefObject } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import { SortableGalleryCard } from "./gallery-card";
import type { GalleryViewProps } from "../../model/gallery-types";
import { isFolderItem, isNestedCollectionItem } from "../../lib/gallery-view";
import { useGalleryViewRuntime } from "../../hooks/gallery/use-gallery-view-runtime";
import {
  CollectionCardsShell,
  CollectionCardsSkeleton,
} from "../presentation-layout";
import * as m from "@/paraglide/messages.js";

export function GalleryView(props: GalleryViewProps) {
  const {
    readOnly,
    query,
    spacePath,
    projectPath,
    onClearSearch,
    onOpenNestedCollection,
    onOpenPath,
  } = props;
  const {
    actors,
    cardFields,
    cardRef,
    cardWidth,
    cancelDraft,
    commitField,
    coverAspect,
    coverFit,
    createDraft,
    draftOpen,
    draftRef,
    draftValue,
    filteredItems,
    focusedPath,
    gridRef,
    handleDragEnd,
    hasSort,
    inputRef,
    loadActors,
    loading,
    metaColumns,
    moveFocus,
    nestedCollectionPaths,
    openCard,
    openDraft,
    queryFiltered,
    resolveCover,
    setDraftValue,
    setFocusedPath,
    topLevelItems,
  } = useGalleryViewRuntime(props);
  const visiblePropertyKeys = new Set(metaColumns.map((column) => column.name));
  const visibleProperties = props.properties.filter((property) =>
    visiblePropertyKeys.has(property.key),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 160, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (loading) return <GallerySkeleton cardWidth={cardWidth} />;

  if (topLevelItems.length === 0 && !queryFiltered && !draftOpen) {
    return (
      <EmptyState
        title={m.table_empty()}
        action={readOnly ? undefined : m.table_create_first_item()}
        onAction={readOnly ? undefined : () => openDraft(false)}
      />
    );
  }

  if (topLevelItems.length === 0 || filteredItems.length === 0) {
    return (
      <EmptyState
        title={m.table_no_results()}
        action={m.table_clear_filters()}
        onAction={() => {
          onClearSearch?.();
          query.setLocalQuery({ filter: [] });
        }}
      />
    );
  }

  return (
    <DndContext
      sensors={readOnly ? undefined : sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        if (!readOnly) void handleDragEnd(event);
      }}
    >
      <div className={detailPageViewRowClassName}>
        <CollectionCardsShell ref={gridRef} cardWidth={cardWidth}>
          <SortableContext
            items={filteredItems.map((item) => item.path)}
            strategy={rectSortingStrategy}
          >
            {filteredItems.map((item) => {
              const nestedCollection = isNestedCollectionItem(
                item,
                nestedCollectionPaths,
              );
              return (
                <SortableGalleryCard
                  key={item.path}
                  item={item}
                  cover={resolveCover(item)}
                  cardFields={cardFields}
                  properties={visibleProperties}
                  coverFit={coverFit}
                  coverAspect={coverAspect}
                  spacePath={spacePath}
                  projectPath={projectPath}
                  actors={actors}
                  nestedCollection={nestedCollection}
                  folder={isFolderItem(item)}
                  disabledReorder={readOnly || hasSort}
                  focused={focusedPath === item.path}
                  cardRef={(element) => cardRef(item.path, element)}
                  onRequestActors={loadActors}
                  onUpdateField={
                    readOnly
                      ? undefined
                      : (itemToUpdate, column, value) =>
                          void commitField(itemToUpdate, column, value)
                  }
                  onOpen={openCard}
                  onOpenNestedCollection={onOpenNestedCollection}
                  onOpenPath={onOpenPath}
                  onFocusCard={setFocusedPath}
                  onKeyboardMove={moveFocus}
                />
              );
            })}
          </SortableContext>
          {!readOnly ? (
            <GalleryCreateTile
              refElement={draftRef}
              open={draftOpen}
              value={draftValue}
              onOpen={(asFolder) => {
                openDraft(asFolder);
              }}
              onValueChange={setDraftValue}
              inputRef={inputRef}
              onCreate={() => void createDraft()}
              onCancel={cancelDraft}
            />
          ) : null}
        </CollectionCardsShell>
      </div>
    </DndContext>
  );
}

function GalleryCreateTile({
  refElement,
  open,
  value,
  inputRef,
  onOpen,
  onValueChange,
  onCreate,
  onCancel,
}: {
  refElement: RefObject<HTMLDivElement | null>;
  open: boolean;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpen: (asFolder: boolean) => void;
  onValueChange: (value: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <Card
      ref={refElement}
      className="h-full min-h-44 justify-center border-dashed bg-muted/20 py-0 shadow-none ring-1 ring-foreground/10 transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-sm"
    >
      <CardContent className="flex min-h-44 flex-col items-center justify-center gap-3 p-3">
        {open ? (
          <Input
            ref={inputRef}
            value={value}
            placeholder={m.table_new_item_placeholder()}
            className="h-8"
            onChange={(event) => onValueChange(event.target.value)}
            onBlur={() => {
              if (!value.trim()) onCancel();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCreate();
              if (event.key === "Escape") onCancel();
            }}
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={(event) => onOpen(event.shiftKey)}
          >
            <Plus data-icon="inline-start" />
            {m.table_new_item_placeholder()}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex p-8">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Settings />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
        </EmptyHeader>
        {action && onAction ? (
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAction}
            >
              {action}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}

function GallerySkeleton({ cardWidth }: { cardWidth: number }) {
  return (
    <div className={detailPageViewRowClassName}>
      <CollectionCardsSkeleton cardWidth={cardWidth} />
    </div>
  );
}
