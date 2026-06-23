import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { PropertyType } from "@/features/properties";
import type { TableEditingCell, TableViewProps } from "../../model/table-types";
import {
  entryParentDir,
  flattenRows,
  normalizeVisibleFields,
  propertyTypeLabel,
  showNestedForView,
} from "../../lib/table-view";
import { titleFilter } from "../../lib/utils";
import { useCollectionActors } from "../use-collection-actors";
import { useCollectionColumnActions } from "../use-collection-column-actions";
import { useCollectionEntryFieldSave } from "../use-collection-entry-field-save";
import {
  usePersistentSet,
  usePersistentSizing,
} from "../use-table-persistence";
import { useTableEntries } from "./use-table-entries";
import { useTableEntryActions } from "./use-table-entry-actions";

export function useTableViewRuntime({
  name,
  view,
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
  onSchemaChange,
  onUpdateView,
  onCreateEntry,
}: TableViewProps) {
  const [editing, setEditing] = useState<TableEditingCell | null>(null);
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
    entries,
    setEntries,
    nestedCollectionPaths,
    nestedSchemas,
    loading,
    error,
    loadEntries,
  } = useTableEntries({
    collectionPath,
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
  const topLevelEntries = useMemo(
    () =>
      entries.filter((entry) => entryParentDir(entry.path) === collectionPath),
    [collectionPath, entries],
  );
  const filteredTopLevel = useMemo(
    () => titleFilter(topLevelEntries, searchQuery),
    [searchQuery, topLevelEntries],
  );
  const rows = useMemo(
    () =>
      flattenRows(
        filteredTopLevel,
        entries,
        expanded,
        collectionPath,
        showNested,
        nestedSchemas,
      ),
    [
      collectionPath,
      entries,
      expanded,
      filteredTopLevel,
      nestedSchemas,
      showNested,
    ],
  );
  const hasSort = sort.length > 0;
  const hasActorColumn = useMemo(
    () => schema.columns.some((column) => column.type === "actor"),
    [schema.columns],
  );
  const { createEntry, reorderEntries } = useTableEntryActions({
    collectionPath,
    spacePath,
    projectPath,
    topLevelEntries,
    filteredTopLevel,
    setEntries,
    loadEntries,
    onCreateEntry,
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
      void loadEntries();
    },
    [loadEntries],
  );
  const { commitField } = useCollectionEntryFieldSave({
    spacePath,
    projectPath,
    setEntries,
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
      const { name: columnName } = await addColumn({
        type,
        baseName: propertyTypeLabel(type),
        relation: type === "relation" ? collectionPath || "." : undefined,
      });
      await updateViewPatch({ visible_fields: [...visibleFields, columnName] });
      setOpenColumn(columnName);
    },
    [addColumn, collectionPath, updateViewPatch, visibleFields],
  );

  const handleCreate = useCallback(
    async (asFolder: boolean) => {
      const title = composerValue.trim();
      if (!title) {
        setComposerOpen(false);
        setComposerAsFolder(false);
        return;
      }
      await createEntry(title, asFolder || composerAsFolder, () => {
        setComposerValue("");
        setComposerOpen(false);
        setComposerAsFolder(false);
      });
    },
    [composerAsFolder, composerValue, createEntry],
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
      await reorderEntries(event);
    },
    [hasSort, reorderEntries],
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
    entries,
    error,
    expanded,
    filteredTopLevel,
    footerInputRef,
    footerRef,
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
    setOpenColumn,
    showNested,
    updateViewPatch,
    visibleFields,
    wrapText,
  };
}
