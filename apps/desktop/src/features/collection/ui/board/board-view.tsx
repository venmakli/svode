import { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { PropertyType } from "@/features/properties";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import {
  useCollectionActors,
  useCollectionColumnActions,
} from "../../hooks";
import { titleFilter } from "../../lib/utils";
import { entryParentDir } from "../table/utils";
import { BoardCardContent } from "./board-card";
import { BoardColumn } from "./board-column";
import type { BoardViewProps } from "./types";
import { useBoardEntryActions } from "./use-board-entry-actions";
import {
  boardColumns,
  boardCustomFields,
  entriesForGroup,
  groupKeyForValue,
  groupValue,
  isGroupableColumn,
  noValueKey,
  normalizeBoardCardFields,
} from "./utils";
import { useBoardEntries } from "./use-board-entries";
import * as m from "@/paraglide/messages.js";

export function BoardView({
  view,
  query,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  searchQuery,
  filters,
  sort,
  refreshToken,
  createFocusSignal = 0,
  createAsFolder = false,
  onClearSearch,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onOpenPath,
  onDuplicateEntry,
  onDeleteEntry,
  onSchemaChange,
  onCreateEntry,
}: BoardViewProps) {
  const [activePath, setActivePath] = useState<string | null>(null);
  const [overGroupKey, setOverGroupKey] = useState<string | null>(null);
  const [draftGroupKey, setDraftGroupKey] = useState<string | null>(null);
  const [draftAsFolder, setDraftAsFolder] = useState(false);
  const lastActiveGroup = useRef<string | null>(null);
  const { actors, loadActors } = useCollectionActors(spacePath);
  const {
    entries,
    setEntries,
    manualOrderEntries,
    setManualOrderEntries,
    nestedCollectionPaths,
    loading,
    loadEntries,
  } = useBoardEntries({
    collectionPath,
    filters,
    projectPath,
    refreshToken,
    sort,
    spacePath,
  });
  const { addColumn } = useCollectionColumnActions({
    schema,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });
  const groupBy = query.merged.groupBy;
  const groupColumn = useMemo(
    () => schema.columns.find((column) => column.name === groupBy) ?? null,
    [groupBy, schema.columns],
  );
  const groupableColumns = useMemo(
    () => schema.columns.filter((column) => isGroupableColumn(column)),
    [schema.columns],
  );
  const cardFields = useMemo(
    () => normalizeBoardCardFields(view, schema),
    [schema, view],
  );
  const customColumns = useMemo(
    () => boardCustomFields(cardFields, schema, groupBy ?? ""),
    [cardFields, groupBy, schema],
  );
  const hasActorCardField = useMemo(
    () => customColumns.some((column) => column.type === "actor"),
    [customColumns],
  );
  const topLevelEntries = useMemo(
    () =>
      entries.filter((entry) => entryParentDir(entry.path) === collectionPath),
    [collectionPath, entries],
  );
  const filteredEntries = useMemo(
    () => titleFilter(topLevelEntries, searchQuery),
    [searchQuery, topLevelEntries],
  );
  const columns = useMemo(
    () =>
      groupColumn ? boardColumns(filteredEntries, groupColumn, actors) : [],
    [filteredEntries, groupColumn, actors],
  );
  const renderedColumns = useMemo(() => {
    if (columns.length > 0 || draftGroupKey !== noValueKey()) return columns;
    return [{ key: noValueKey(), value: null, label: m.board_no_value() }];
  }, [columns, draftGroupKey]);
  const hasSort = sort.length > 0;
  const activeCard = activePath
    ? filteredEntries.find((entry) => entry.path === activePath)
    : null;
  const { commitField, createDraft, moveCard } = useBoardEntryActions({
    collectionPath,
    spacePath,
    projectPath,
    entries,
    manualOrderEntries,
    topLevelEntries,
    groupColumn,
    hasSort,
    setEntries,
    setManualOrderEntries,
    loadEntries,
    onCreateEntry,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    if (groupColumn?.type !== "actor" && !hasActorCardField) return;
    void loadActors().catch((error) => {
      console.warn("Failed to load board actors:", error);
    });
  }, [groupColumn?.type, hasActorCardField, loadActors]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const key =
        lastActiveGroup.current &&
        renderedColumns.some((column) => column.key === lastActiveGroup.current)
          ? lastActiveGroup.current
          : (renderedColumns[0]?.key ?? noValueKey());
      if (!key) return;
      setDraftGroupKey(key);
      setDraftAsFolder(createAsFolder);
    });
    return () => {
      cancelled = true;
    };
  }, [createAsFolder, createFocusSignal, renderedColumns]);

  function handleDragStart(event: DragStartEvent) {
    setActivePath(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent) {
    setOverGroupKey(groupKeyFromOver(event.over?.data.current));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActivePath(null);
    setOverGroupKey(null);
    if (!event.over || event.active.id === event.over.id) return;

    const overData = event.over.data.current;
    await moveCard({
      activeEntryPath: String(event.active.id),
      targetGroupKey: groupKeyFromOver(overData),
      overEntryPath:
        overData?.type === "card" ? String(overData.entryPath) : null,
      placement: dropPlacement(event),
    });
  }

  async function addGroupColumn(type: PropertyType = "status") {
    const { name } = await addColumn({
      type,
      baseName: "Status",
    });
    query.setLocalQuery({ groupBy: name });
  }

  if (loading) {
    return (
      <div
        className={`${detailPageViewRowClassName} text-sm text-muted-foreground`}
      />
    );
  }

  const queryFiltered = searchQuery.trim().length > 0 || filters.length > 0;

  if (!groupColumn || !isGroupableColumn(groupColumn)) {
    return (
      <div className="flex p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Settings />
            </EmptyMedia>
            <EmptyTitle>
              {groupableColumns.length === 0
                ? m.board_no_groupable_title()
                : m.collection_board_incomplete()}
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            {groupableColumns.length === 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void addGroupColumn("status").catch(console.error)
                }
              >
                {m.board_add_status_column()}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  query.setLocalQuery({ groupBy: groupableColumns[0].name })
                }
              >
                {m.view_query_add_group()}
              </Button>
            )}
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  if (topLevelEntries.length === 0 && !queryFiltered && !draftGroupKey) {
    return (
      <div className="flex p-8">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.table_empty()}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const key = renderedColumns[0]?.key ?? noValueKey();
                setDraftGroupKey(key);
                setDraftAsFolder(false);
              }}
            >
              {m.table_create_first_entry()}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  if (topLevelEntries.length === 0 || filteredEntries.length === 0) {
    return (
      <div className="flex p-8">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.table_no_results()}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onClearSearch?.();
                query.setLocalQuery({ filter: [] });
              }}
            >
              {m.table_clear_filters()}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const activeModel = activeCard
    ? {
        entry: activeCard,
        groupKey: groupKeyForValue(groupValue(activeCard, groupColumn)),
      }
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={(event) => void handleDragEnd(event)}
      onDragCancel={() => {
        setActivePath(null);
        setOverGroupKey(null);
      }}
    >
      <div
        className={`scrollbar-hide overflow-x-auto ${detailPageViewRowClassName}`}
      >
        <div className="flex min-w-max items-start gap-3">
          {renderedColumns.map((column) => {
            const groupEntries = entriesForGroup(
              filteredEntries,
              groupColumn,
              column.key,
            );
            const cards = groupEntries.map((entry) => ({
              entry,
              groupKey: column.key,
            }));
            return (
              <BoardColumn
                key={column.key}
                group={column}
                cards={cards}
                count={groupEntries.length}
                activeEntryPath={activePath}
                overGroupKey={overGroupKey}
                draftOpen={draftGroupKey === column.key}
                draftAsFolder={draftAsFolder}
                onPointerEnter={() => {
                  lastActiveGroup.current = column.key;
                }}
                onOpenDraft={(asFolder) => {
                  lastActiveGroup.current = column.key;
                  setDraftGroupKey(column.key);
                  setDraftAsFolder(asFolder);
                }}
                onCancelDraft={() => {
                  setDraftGroupKey(null);
                  setDraftAsFolder(false);
                }}
                onCreateDraft={(title, asFolder) =>
                  void createDraft(title, column.key, asFolder, () => {
                    setDraftGroupKey(null);
                    setDraftAsFolder(false);
                  })
                }
                cardProps={{
                  groupColumn,
                  cardFields,
                  customColumns,
                  nestedCollectionPaths,
                  disabledReorder: hasSort,
                  overlay: false,
                  spacePath,
                  projectPath,
                  actors,
                  onRequestActors: loadActors,
                  onUpdateField: (entry, column, value) =>
                    void commitField(entry, column, value),
                  onOpen: onOpenEntry,
                  onOpenNestedPeek,
                  onOpenNestedCollection,
                  onOpenFullPage,
                  onOpenPath,
                  onDuplicate: onDuplicateEntry,
                  onDelete: onDeleteEntry,
                }}
              />
            );
          })}
        </div>
      </div>
      <DragOverlay>
        {activeModel ? (
          <BoardCardContent
            card={activeModel}
            groupColumn={groupColumn}
            cardFields={cardFields}
            customColumns={customColumns}
            nestedCollectionPaths={nestedCollectionPaths}
            disabledReorder={hasSort}
            active
            overlay
            spacePath={spacePath}
            projectPath={projectPath}
            actors={actors}
            onRequestActors={loadActors}
            onOpen={onOpenEntry}
            onOpenNestedPeek={onOpenNestedPeek}
            onOpenNestedCollection={onOpenNestedCollection}
            onOpenFullPage={onOpenFullPage}
            onOpenPath={onOpenPath}
            onDuplicate={onDuplicateEntry}
            onDelete={onDeleteEntry}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function groupKeyFromOver(data: Record<string, unknown> | undefined) {
  if (!data) return null;
  if (data.type === "card" || data.type === "column") {
    return typeof data.groupKey === "string" ? data.groupKey : null;
  }
  return null;
}

function dropPlacement(event: DragEndEvent): "before" | "after" {
  const activeRect = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  if (!activeRect || !overRect) return "before";
  const activeCenter = activeRect.top + activeRect.height / 2;
  const overCenter = overRect.top + overRect.height / 2;
  return activeCenter > overCenter ? "after" : "before";
}
