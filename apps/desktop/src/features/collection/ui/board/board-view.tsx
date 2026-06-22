import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useEntryFieldSave, type Entry } from "@/features/entry";
import { useStableViewQueryArgs } from "@/features/collection/query";
import type {
  Column,
  CollectionSchema,
  PropertyType,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { propertyFieldSavePolicy } from "@/features/properties";
import { useSpace, useSpaceTreeSync } from "@/features/space";
import { detailPageViewRowClassName } from "@/shared/ui/page-layout";
import { useCollectionActors } from "../../hooks";
import { titleFilter } from "../../lib/utils";
import {
  entryParentDir,
  saveTableOrder,
  uniqueColumnName,
} from "../table/utils";
import { BoardCardContent } from "./board-card";
import { BoardColumn } from "./board-column";
import type { BoardViewProps, CollectionInfo } from "./types";
import {
  boardColumns,
  boardCustomFields,
  entriesForGroup,
  groupKeyForValue,
  groupValue,
  groupValueForKey,
  isGroupableColumn,
  noValueKey,
  normalizeBoardCardFields,
  reorderEntryAround,
  updateEntryGroupValue,
} from "./utils";
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
  const [entries, setEntries] = useState<Entry[]>([]);
  const [manualOrderEntries, setManualOrderEntries] = useState<Entry[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(true);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [overGroupKey, setOverGroupKey] = useState<string | null>(null);
  const [draftGroupKey, setDraftGroupKey] = useState<string | null>(null);
  const [draftAsFolder, setDraftAsFolder] = useState(false);
  const lastActiveGroup = useRef<string | null>(null);
  const { actors, loadActors } = useCollectionActors(spacePath);
  const queryArgs = useStableViewQueryArgs(filters, sort);
  const sidebarSpaceId = useSpace((state) => {
    const space =
      state.spaces.find((item) => item.path === spacePath) ??
      state.rootSpaces.find((item) => item.path === spacePath);
    return space?.id ?? null;
  });
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const loadEntries = useCallback(async () => {
    const hasActiveSort = queryArgs.sort.length > 0;
    setLoading(true);
    try {
      const [baseEntries, orderEntries, collections] = await Promise.all([
        invoke<Entry[]>("query_entries", {
          space: spacePath,
          collectionPath,
          filters: queryArgs.filters,
          sort: queryArgs.sort,
          includeNested: false,
          limit: null,
          offset: null,
          projectPath: projectPath ?? null,
        }),
        hasActiveSort
          ? Promise.resolve<Entry[]>([])
          : invoke<Entry[]>("query_entries", {
              space: spacePath,
              collectionPath,
              filters: null,
              sort: null,
              includeNested: false,
              limit: null,
              offset: null,
              projectPath: projectPath ?? null,
            }),
        invoke<CollectionInfo[]>("list_collections", {
          space: spacePath,
        }).catch(() => []),
      ]);
      setEntries(baseEntries);
      setManualOrderEntries(hasActiveSort ? baseEntries : orderEntries);
      setNestedCollectionPaths(new Set(collections.map((item) => item.path)));
    } catch (error) {
      console.warn("Failed to load board entries:", error);
      toast.error(m.board_error_title());
    } finally {
      setLoading(false);
    }
  }, [collectionPath, projectPath, queryArgs, spacePath]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  useEffect(() => {
    if (groupColumn?.type !== "actor" && !hasActorCardField) return;
    void loadActors().catch((error) => {
      console.warn("Failed to load board actors:", error);
    });
  }, [groupColumn?.type, hasActorCardField, loadActors]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    const key =
      lastActiveGroup.current &&
      renderedColumns.some((column) => column.key === lastActiveGroup.current)
        ? lastActiveGroup.current
        : (renderedColumns[0]?.key ?? noValueKey());
    if (!key) return;
    setDraftGroupKey(key);
    setDraftAsFolder(createAsFolder);
  }, [createAsFolder, createFocusSignal, renderedColumns]);

  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
      setManualOrderEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
    },
    [],
  );
  const saveEntryField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
  });

  function handleDragStart(event: DragStartEvent) {
    setActivePath(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent) {
    setOverGroupKey(groupKeyFromOver(event.over?.data.current));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActivePath(null);
    setOverGroupKey(null);
    if (!groupColumn || !event.over || event.active.id === event.over.id)
      return;

    const activeEntryPath = String(event.active.id);
    const activeEntry = topLevelEntries.find(
      (entry) => entry.path === activeEntryPath,
    );
    if (!activeEntry) return;

    const overData = event.over.data.current;
    const targetGroupKey = groupKeyFromOver(overData);
    if (!targetGroupKey) return;

    const sourceGroupKey = groupKeyForValue(
      groupValue(activeEntry, groupColumn),
    );
    const targetValue = groupValueForKey(targetGroupKey);
    const overEntryPath =
      overData?.type === "card" ? String(overData.entryPath) : null;
    const crossColumn = sourceGroupKey !== targetGroupKey;
    const positional = Boolean(overEntryPath) && !hasSort;
    const placement = dropPlacement(event);

    if (!crossColumn && (!positional || activeEntryPath === overEntryPath)) {
      return;
    }
    if (hasSort && !crossColumn) return;

    const previousEntries = entries;
    const previousManualOrderEntries = manualOrderEntries;
    const orderTopLevelEntries = (
      manualOrderEntries.length > 0 ? manualOrderEntries : topLevelEntries
    ).filter((entry) => entryParentDir(entry.path) === collectionPath);
    const withGroup = crossColumn
      ? topLevelEntries.map((entry) =>
          entry.path === activeEntryPath
            ? updateEntryGroupValue(entry, groupColumn, targetValue)
            : entry,
        )
      : topLevelEntries;
    const withGroupForOrder = crossColumn
      ? orderTopLevelEntries.map((entry) =>
          entry.path === activeEntryPath
            ? updateEntryGroupValue(entry, groupColumn, targetValue)
            : entry,
        )
      : orderTopLevelEntries;
    const nextTopLevel =
      positional && overEntryPath
        ? reorderEntryAround(
            withGroup,
            activeEntryPath,
            overEntryPath,
            placement,
          )
        : withGroup;
    const nextOrderTopLevel =
      positional && overEntryPath
        ? reorderEntryAround(
            withGroupForOrder,
            activeEntryPath,
            overEntryPath,
            placement,
          )
        : withGroupForOrder;
    setEntries((current) =>
      positional
        ? [
            ...nextTopLevel,
            ...current.filter(
              (entry) => entryParentDir(entry.path) !== collectionPath,
            ),
          ]
        : current.map((entry) =>
            entry.path === activeEntryPath
              ? updateEntryGroupValue(entry, groupColumn, targetValue)
              : entry,
          ),
    );
    setManualOrderEntries((current) =>
      positional
        ? [
            ...nextOrderTopLevel,
            ...current.filter(
              (entry) => entryParentDir(entry.path) !== collectionPath,
            ),
          ]
        : current.map((entry) =>
            entry.path === activeEntryPath
              ? updateEntryGroupValue(entry, groupColumn, targetValue)
              : entry,
          ),
    );

    try {
      if (crossColumn) {
        await saveEntryField(activeEntry, groupColumn.name, targetValue, {
          policy: propertyFieldSavePolicy(groupColumn),
          flush: true,
        });
      }
      if (positional) {
        await saveTableOrder(
          spacePath,
          collectionPath,
          nextOrderTopLevel,
          projectPath,
        );
        if (sidebarSpaceId)
          await reloadTreeParent(sidebarSpaceId, collectionPath);
      }
      await loadEntries();
    } catch (error) {
      console.warn("Failed to move board card:", error);
      if (crossColumn) {
        try {
          await saveEntryField(
            activeEntry,
            groupColumn.name,
            groupValueForKey(sourceGroupKey),
            {
              policy: propertyFieldSavePolicy(groupColumn),
              flush: true,
            },
          );
        } catch (rollbackError) {
          console.warn("Failed to rollback board card move:", rollbackError);
        }
      }
      setEntries(previousEntries);
      setManualOrderEntries(previousManualOrderEntries);
      void loadEntries();
      toast.error(m.board_move_error());
    }
  }

  async function createDraft(
    title: string,
    groupKey: string,
    asFolder: boolean,
  ) {
    const defaults =
      groupKey === noValueKey() || !groupColumn
        ? undefined
        : { [groupColumn.name]: groupValueForKey(groupKey) };
    const created = await onCreateEntry(title, asFolder, defaults);
    setDraftGroupKey(null);
    setDraftAsFolder(false);
    setEntries((current) => [...current, created]);
    setManualOrderEntries((current) => [...current, created]);
    await loadEntries();
  }

  const commitField = useCallback(
    async (entry: Entry, column: Column, value: unknown) => {
      try {
        await saveEntryField(entry, column.name, value, {
          policy: propertyFieldSavePolicy(column),
        });
      } catch (error) {
        console.warn("Failed to update board field:", error);
        void loadEntries();
      }
    },
    [loadEntries, saveEntryField],
  );

  async function addGroupColumn(type: PropertyType = "status") {
    const column = { name: uniqueColumnName(schema, "Status"), type };
    const next = await invoke<CollectionSchema>("add_schema_column", {
      space: spacePath,
      collectionPath,
      column,
      projectPath: projectPath ?? null,
    });
    onSchemaChange(normalizeSchema(next));
    query.setLocalQuery({ groupBy: column.name });
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
                  void createDraft(title, column.key, asFolder).catch(
                    (error) => {
                      console.warn("Failed to create board entry:", error);
                      toast.error(m.board_create_error());
                    },
                  )
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
