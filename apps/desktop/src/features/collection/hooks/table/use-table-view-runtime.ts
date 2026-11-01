import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { PropertyType } from "@/features/properties";
import { notifyPropertyAddFailed } from "@/features/properties";
import type { TableEditingCell, TableViewProps } from "../../model/table-types";
import {
  itemParentDir,
  flattenRows,
  normalizeVisibleFields,
  showNestedForView,
} from "../../lib/table-view";
import { titleFilter } from "../../lib/utils";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionColumnActions } from "../use-collection-column-actions";
import { useCollectionItemFieldSave } from "../use-collection-item-field-save";
import { handleItemCreateError, handleError } from "../error-feedback";
import {
  usePersistentSet,
  usePersistentSizing,
} from "../use-table-persistence";
import { useTableItems } from "./use-table-items";
import { useTableItemActions } from "./use-table-item-actions";

export function useTableViewRuntime({
  name,
  view,
  schema,
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
  onUpdateView,
  onCreatePage,
}: TableViewProps) {
  const [editing, setEditing] = useState<TableEditingCell | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerAsFolder, setComposerAsFolder] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const showNested = showNestedForView(view);
  const density: "compact" | "default" | "spacious" =
    view.density === "compact" || view.density === "spacious"
      ? view.density
      : "default";
  const wrapText = Boolean(view.wrap_text ?? view.wrapText);
  const [expanded, setExpanded] = usePersistentSet(
    `svode:table-expanded:${spacePath}:${collectionPath}:${name}`,
  );
  const [columnSizing, setColumnSizing] = usePersistentSizing(
    `svode:table-column-widths:${spacePath}:${collectionPath}`,
  );
  const footerInputRef = useRef<HTMLInputElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const { actors, loadActors } = useCollectionActors(spacePath);
  const {
    items,
    setItems,
    nestedCollectionPaths,
    nestedSchemas,
    loading,
    error,
    loadItems,
  } = useTableItems({
    collectionPath,
    previousCollectionPath,
    filters,
    includeNested: showNested,
    projectPath,
    refreshToken,
    sort,
    spacePath,
  });

  const visibleFields = useMemo(
    () => normalizeVisibleFields(view, schema),
    [schema, view],
  );
  const topLevelItems = useMemo(
    () => items.filter((item) => itemParentDir(item.path) === collectionPath),
    [collectionPath, items],
  );
  const filteredTopLevel = useMemo(
    () => titleFilter(topLevelItems, searchQuery),
    [searchQuery, topLevelItems],
  );
  const rows = useMemo(
    () =>
      flattenRows(
        filteredTopLevel,
        items,
        expanded,
        collectionPath,
        showNested,
        nestedSchemas,
      ),
    [
      collectionPath,
      items,
      expanded,
      filteredTopLevel,
      nestedSchemas,
      showNested,
    ],
  );
  const hasSort = sort.length > 0;
  const visibleFocusedPath =
    focusedPath && rows.some((row) => row.item.path === focusedPath)
      ? focusedPath
      : null;
  const hasActorColumn = useMemo(
    () => schema.columns.some((column) => column.type === "actor"),
    [schema.columns],
  );
  const { createItem, reorderItems } = useTableItemActions({
    collectionPath,
    spacePath,
    projectPath,
    topLevelItems,
    filteredTopLevel,
    setItems,
    loadItems,
    onCreatePage,
  });

  useEffect(() => {
    if (!hasActorColumn) return;
    void loadActors().catch((loadError) => {
      console.warn("Failed to load table actors:", loadError);
    });
  }, [hasActorColumn, loadActors]);

  useEffect(() => {
    if (composerOpen) footerInputRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    if (createFocusSignal <= 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setComposerOpen(true);
      setComposerAsFolder(createAsFolder);
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        footerRef.current?.scrollIntoView({ block: "nearest" });
        footerInputRef.current?.focus();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [createAsFolder, createFocusSignal]);

  const handleFieldCommitError = useCallback(
    (saveError: unknown) => {
      console.warn("Failed to update table field:", saveError);
      void loadItems();
    },
    [loadItems],
  );
  const { commitField } = useCollectionItemFieldSave({
    spacePath,
    projectPath,
    setItems,
    onCommitError: handleFieldCommitError,
  });

  const updateViewPatch = useCallback(
    (patch: Record<string, unknown>) => onUpdateView(name, patch),
    [name, onUpdateView],
  );
  const { addColumn } = useCollectionColumnActions({
    schema,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });

  const handleAddColumn = useCallback(
    async (type: PropertyType) => {
      let columnName: string;
      try {
        ({ name: columnName } = await addColumn(type));
      } catch (error) {
        notifyPropertyAddFailed(error);
        return;
      }
      try {
        await updateViewPatch({
          visible_fields: [...visibleFields, columnName],
        });
      } catch (error) {
        handleError(error);
        return;
      }
      setOpenColumn(columnName);
    },
    [addColumn, updateViewPatch, visibleFields],
  );

  const handleCreate = useCallback(
    async (asFolder: boolean) => {
      const title = composerValue.trim();
      if (!title) {
        setComposerOpen(false);
        setComposerAsFolder(false);
        return;
      }
      try {
        await createItem(title, asFolder || composerAsFolder, () => {
          setComposerValue("");
          setComposerOpen(false);
          setComposerAsFolder(false);
        });
      } catch (error) {
        handleItemCreateError(error);
      }
    },
    [composerAsFolder, composerValue, createItem],
  );

  const openComposer = useCallback((asFolder: boolean) => {
    setComposerAsFolder(asFolder);
    setComposerOpen(true);
  }, []);

  const cancelComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerAsFolder(false);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (hasSort) return;
      await reorderItems(event);
    },
    [hasSort, reorderItems],
  );

  return {
    actors,
    cancelComposer,
    columnSizing,
    commitField,
    composerOpen,
    composerValue,
    density,
    editing,
    items,
    error,
    expanded,
    filteredTopLevel,
    footerInputRef,
    footerRef,
    focusedPath: visibleFocusedPath,
    handleAddColumn,
    handleCreate,
    handleDragEnd,
    hasSort,
    loadActors,
    loading,
    nestedCollectionPaths,
    openColumn,
    openComposer,
    rows,
    setColumnSizing,
    setComposerValue,
    setEditing,
    setExpanded,
    setFocusedPath,
    setOpenColumn,
    showNested,
    updateViewPatch,
    visibleFields,
    wrapText,
  };
}
