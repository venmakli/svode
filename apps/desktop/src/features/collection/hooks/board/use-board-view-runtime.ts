import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  resolveStandardPropertyColumn,
  type Column,
  type PropertyType,
} from "@/features/properties";
import type { BoardViewProps } from "../../model/board-types";
import { titleFilter } from "../../lib/utils";
import { entryParentDir } from "../../lib/entry-tree";
import {
  boardColumns,
  groupKeyForValue,
  groupValue,
  isGroupableColumn,
  noValueKey,
  normalizeBoardCardFields,
} from "../../lib/board-view";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionColumnActions } from "../use-collection-column-actions";
import { useBoardEntries } from "./use-board-entries";
import { useBoardEntryActions } from "./use-board-entry-actions";
import * as m from "@/paraglide/messages.js";

export function useBoardViewRuntime({
  view,
  query,
  schema,
  properties,
  collectionPath,
  previousCollectionPath,
  spacePath,
  projectPath,
  searchQuery,
  filters,
  sort,
  refreshToken,
  createFocusSignal = 0,
  createAsFolder = false,
  onSchemaChange,
  onCreatePage,
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
    previousCollectionPath,
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
  const propertyColumns = useMemo(
    () =>
      properties
        .map((property) => resolveStandardPropertyColumn(property))
        .filter((column): column is Column => Boolean(column)),
    [properties],
  );
  const groupColumn = useMemo(
    () => propertyColumns.find((column) => column.name === groupBy) ?? null,
    [groupBy, propertyColumns],
  );
  const groupableColumns = useMemo(
    () => propertyColumns.filter((column) => isGroupableColumn(column)),
    [propertyColumns],
  );
  const cardFields = useMemo(
    () => normalizeBoardCardFields(view, schema),
    [schema, view],
  );
  const customColumns = useMemo(
    () =>
      propertyColumns.filter(
        (column) =>
          cardFields.includes(column.name) &&
          column.name !== groupBy &&
          !["title", "icon", "description"].includes(column.name),
      ),
    [cardFields, groupBy, propertyColumns],
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
  const activeModel =
    activeCard && groupColumn
      ? {
          entry: activeCard,
          groupKey: groupKeyForValue(groupValue(activeCard, groupColumn)),
        }
      : null;
  const queryFiltered = searchQuery.trim().length > 0 || filters.length > 0;
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
    onCreatePage,
  });

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActivePath(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverGroupKey(groupKeyFromOver(event.over?.data.current));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
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
    },
    [moveCard],
  );

  const handleDragCancel = useCallback(() => {
    setActivePath(null);
    setOverGroupKey(null);
  }, []);

  const addGroupColumn = useCallback(
    async (type: PropertyType = "status") => {
      const { name } = await addColumn({
        type,
        baseName: "Status",
      });
      query.setLocalQuery({ groupBy: name });
    },
    [addColumn, query],
  );

  const selectGroupColumn = useCallback(
    (fieldName: string) => {
      query.setLocalQuery({ groupBy: fieldName });
    },
    [query],
  );

  const openInitialDraft = useCallback(
    (asFolder = false) => {
      const key = renderedColumns[0]?.key ?? noValueKey();
      setDraftGroupKey(key);
      setDraftAsFolder(asFolder);
    },
    [renderedColumns],
  );

  const openDraftForGroup = useCallback(
    (groupKey: string, asFolder: boolean) => {
      lastActiveGroup.current = groupKey;
      setDraftGroupKey(groupKey);
      setDraftAsFolder(asFolder);
    },
    [],
  );

  const cancelDraft = useCallback(() => {
    setDraftGroupKey(null);
    setDraftAsFolder(false);
  }, []);

  const createDraftForGroup = useCallback(
    (title: string, groupKey: string, asFolder: boolean) =>
      createDraft(title, groupKey, asFolder, () => {
        setDraftGroupKey(null);
        setDraftAsFolder(false);
      }),
    [createDraft],
  );

  const markActiveGroup = useCallback((groupKey: string) => {
    lastActiveGroup.current = groupKey;
  }, []);

  return {
    activeModel,
    actors,
    addGroupColumn,
    cancelDraft,
    cardFields,
    commitField,
    createDraftForGroup,
    customColumns,
    draftAsFolder,
    draftGroupKey,
    filteredEntries,
    groupColumn,
    groupableColumns,
    handleDragCancel,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    hasSort,
    loadActors,
    loading,
    markActiveGroup,
    nestedCollectionPaths,
    openDraftForGroup,
    openInitialDraft,
    overGroupKey,
    queryFiltered,
    renderedColumns,
    selectGroupColumn,
    topLevelEntries,
  };
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
