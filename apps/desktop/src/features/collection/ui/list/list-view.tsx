import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { SortableListRow } from "./list-row";
import type { ListViewProps } from "../../model/list-types";
import { useListViewRuntime } from "../../hooks/list/use-list-view-runtime";
import * as m from "@/paraglide/messages.js";

export function ListView(props: ListViewProps) {
  const {
    query,
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
    cardFields,
    cancelComposer,
    closeComposer,
    commitField,
    composerOpen,
    composerValue,
    createDraft,
    density,
    filteredTopLevel,
    focusedPath,
    footerRef,
    handleDragEnd,
    hasSort,
    inputRef,
    loadActors,
    loading,
    metaColumns,
    moveFocus,
    openComposer,
    openRow,
    queryFiltered,
    rowRef,
    rows,
    setComposerValue,
    setFocusedPath,
    topLevelEntries,
    toggleRow,
  } = useListViewRuntime(props);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (loading) return <ListSkeleton density={density} />;

  if (topLevelEntries.length === 0 && !queryFiltered && !composerOpen) {
    return (
      <EmptyState
        title={m.table_empty()}
        action={m.table_create_first_entry()}
        onAction={() => openComposer(false)}
      />
    );
  }

  if (topLevelEntries.length === 0 || filteredTopLevel.length === 0) {
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
        <div className="overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10">
          <SortableContext
            items={rows.map((row) => row.entry.path)}
            strategy={verticalListSortingStrategy}
          >
            {rows.map((row) => (
              <SortableListRow
                key={row.entry.path}
                row={row}
                density={density}
                cardFields={cardFields}
                metaColumns={metaColumns}
                spacePath={spacePath}
                projectPath={projectPath}
                actors={actors}
                disabledReorder={hasSort}
                focused={focusedPath === row.entry.path}
                rowRef={(element) => rowRef(row.entry.path, element)}
                onRequestActors={loadActors}
                onUpdateField={(entry, column, value) =>
                  void commitField(entry, column, value)
                }
                onToggle={toggleRow}
                onOpen={openRow}
                onOpenFullPage={onOpenFullPage}
                onOpenNestedCollection={onOpenNestedCollection}
                onOpenPath={onOpenPath}
                onDuplicate={onDuplicateEntry}
                onDelete={onDeleteEntry}
                onFocusRow={setFocusedPath}
                onKeyboardMove={moveFocus}
              />
            ))}
          </SortableContext>
        </div>
        <div
          ref={footerRef}
          className="flex items-center justify-between gap-3 px-1 py-3"
        >
          {composerOpen ? (
            <Input
              ref={inputRef}
              value={composerValue}
              placeholder={m.table_new_entry_placeholder()}
              className="h-8 max-w-sm"
              onChange={(event) => setComposerValue(event.target.value)}
              onBlur={() => {
                if (!composerValue.trim()) closeComposer();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createDraft();
                if (event.key === "Escape") cancelComposer();
              }}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={(event) => {
                openComposer(event.shiftKey);
              }}
            >
              <Plus data-icon="inline-start" />
              {m.table_new_entry_placeholder()}
            </Button>
          )}
          <span className="shrink-0 text-xs text-muted-foreground">
            {m.table_entries_count({ count: rows.length })}
          </span>
        </div>
      </div>
    </DndContext>
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

function ListSkeleton({ density }: { density: "compact" | "comfortable" }) {
  return (
    <div className={detailPageViewRowClassName}>
      <div className="overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
          >
            <Skeleton className="size-4" />
            <div className="flex min-w-0 flex-col gap-2">
              <Skeleton className="h-4 w-48 max-w-full" />
              {density === "comfortable" ? (
                <Skeleton className="h-3 w-72 max-w-full" />
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
