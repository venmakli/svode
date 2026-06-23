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
import { Skeleton } from "@/components/ui/skeleton";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import { SortableGalleryCard } from "./gallery-card";
import type { GalleryViewProps } from "../../model/gallery-types";
import { isFolderEntry, isNestedCollectionEntry } from "../../lib/gallery-view";
import { useGalleryViewRuntime } from "../../hooks/gallery/use-gallery-view-runtime";
import * as m from "@/paraglide/messages.js";

export function GalleryView(props: GalleryViewProps) {
  const {
    query,
    schema,
    spacePath,
    projectPath,
    onClearSearch,
    onOpenFullPage,
    onOpenNestedCollection,
    onOpenPath,
    onDuplicateEntry,
    onDeleteEntry,
  } = props;
  const {
    actors,
    cardCover,
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
    filteredEntries,
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
    setDraftValue,
    setFocusedPath,
    topLevelEntries,
  } = useGalleryViewRuntime(props);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 160, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (loading) return <GallerySkeleton cardWidth={cardWidth} />;

  if (topLevelEntries.length === 0 && !queryFiltered && !draftOpen) {
    return (
      <EmptyState
        title={m.table_empty()}
        action={m.table_create_first_entry()}
        onAction={() => openDraft(false)}
      />
    );
  }

  if (topLevelEntries.length === 0 || filteredEntries.length === 0) {
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
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => void handleDragEnd(event)}
    >
      <div className={detailPageViewRowClassName}>
        <div
          ref={gridRef}
          className="grid items-stretch gap-3.5"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
          }}
        >
          <SortableContext
            items={filteredEntries.map((entry) => entry.path)}
            strategy={rectSortingStrategy}
          >
            {filteredEntries.map((entry) => {
              const nestedCollection = isNestedCollectionEntry(
                entry,
                nestedCollectionPaths,
              );
              return (
                <SortableGalleryCard
                  key={entry.path}
                  entry={entry}
                  schema={schema}
                  cardCover={cardCover}
                  cardFields={cardFields}
                  metaColumns={metaColumns}
                  coverFit={coverFit}
                  coverAspect={coverAspect}
                  spacePath={spacePath}
                  projectPath={projectPath}
                  actors={actors}
                  nestedCollection={nestedCollection}
                  folder={isFolderEntry(entry)}
                  disabledReorder={hasSort}
                  focused={focusedPath === entry.path}
                  cardRef={(element) => cardRef(entry.path, element)}
                  onRequestActors={loadActors}
                  onUpdateField={(entryToUpdate, column, value) =>
                    void commitField(entryToUpdate, column, value)
                  }
                  onOpen={openCard}
                  onOpenFullPage={onOpenFullPage}
                  onOpenNestedCollection={onOpenNestedCollection}
                  onOpenPath={onOpenPath}
                  onDuplicate={onDuplicateEntry}
                  onDelete={onDeleteEntry}
                  onFocusCard={setFocusedPath}
                  onKeyboardMove={moveFocus}
                />
              );
            })}
          </SortableContext>
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
        </div>
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
            placeholder={m.table_new_entry_placeholder()}
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
            {m.table_new_entry_placeholder()}
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
  action: string;
  onAction: () => void;
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
        <EmptyContent>
          <Button type="button" variant="outline" size="sm" onClick={onAction}>
            {action}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function GallerySkeleton({ cardWidth }: { cardWidth: number }) {
  return (
    <div className={detailPageViewRowClassName}>
      <div
        className="grid gap-3.5"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
        }}
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <Card
            key={index}
            size="sm"
            className="gap-0 overflow-hidden py-0 shadow-none ring-1 ring-foreground/10"
          >
            <Skeleton className="aspect-video w-full rounded-none" />
            <CardContent className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-14" />
                <Skeleton className="h-5 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
