import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Table } from "@/components/ui/table";
import { propertyFieldSavePolicy, type Entry } from "@/features/entry";
import { useEntryFieldSave } from "@/features/entry/field-save";
import { normalizeSchema } from "@/features/properties";
import { useSpace, useSpaceTreeSync } from "@/features/space";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import { addCollectionColumn } from "../../api";
import type { Column, PropertyType } from "@/features/properties";
import { useCollectionActors } from "../../hooks";
import { titleFilter } from "../../lib/utils";
import { isEditableTarget } from "../../lib/utils";
import {
  usePersistentSet,
  usePersistentSizing,
} from "../../hooks/use-table-persistence";
import { propertyTypeLabel } from "./property-type-picker";
import { EmptyTableBody } from "./table-empty-state";
import { TableFooterComposer } from "./table-footer-composer";
import { TableHeaderRow } from "./table-header-row";
import { TableRowsBody } from "./table-rows-body";
import { ErrorState, LoadingTable, TableShell } from "./table-shell";
import type { TableEditingCell, TableViewProps } from "./types";
import { useTableColumns } from "./use-table-columns";
import { useTableEntries } from "./use-table-entries";
import {
  entryParentDir,
  flattenRows,
  normalizeVisibleFields,
  reorderVisibleEntries,
  saveTableOrder,
  showNestedForView,
  uniqueColumnName,
} from "./utils";
import * as m from "@/paraglide/messages.js";

export function TableView({
  name,
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
  onUpdateView,
  onCreateEntry,
}: TableViewProps) {
  const [editing, setEditing] = useState<TableEditingCell | null>(null);
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerAsFolder, setComposerAsFolder] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const sidebarSpaceId = useSpace((state) => {
    const space =
      state.spaces.find((item) => item.path === spacePath) ??
      state.rootSpaces.find((item) => item.path === spacePath);
    return space?.id ?? null;
  });
  const reloadTreeParent = useSpaceTreeSync((state) => state.reloadTreeParent);
  const showNested = showNestedForView(view);
  const density =
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
    setComposerOpen(true);
    setComposerAsFolder(createAsFolder);
    window.requestAnimationFrame(() => {
      footerRef.current?.scrollIntoView({ block: "nearest" });
      footerInputRef.current?.focus();
    });
  }, [createAsFolder, createFocusSignal]);

  const applyEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntries((current) =>
        current.map((item) => (item.path === entryPath ? update(item) : item)),
      );
    },
    [setEntries],
  );
  const saveEntryField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate,
  });

  const commitField = useCallback(
    async (
      entry: Entry,
      column: Column,
      value: unknown,
      options?: { flush?: boolean },
    ) => {
      try {
        await saveEntryField(entry, column.name, value, {
          policy: propertyFieldSavePolicy(column),
          flush: options?.flush,
        });
      } catch (saveError) {
        console.warn("Failed to update table field:", saveError);
        void loadEntries();
      }
    },
    [loadEntries, saveEntryField],
  );

  const updateViewPatch = useCallback(
    (patch: Record<string, unknown>) => onUpdateView(name, patch),
    [name, onUpdateView],
  );

  const tableColumns = useTableColumns({
    visibleFields,
    schema,
    view,
    query,
    collectionPath,
    spacePath,
    projectPath,
    columnSizing,
    editing,
    openColumn,
    entries,
    expanded,
    nestedCollectionPaths,
    showNested,
    actors,
    setEditing,
    setOpenColumn,
    setExpanded,
    onSchemaChange,
    onUpdateViewPatch: updateViewPatch,
    onOpenEntry,
    onOpenNestedPeek: onOpenNestedPeek ?? onOpenEntry,
    onOpenNestedCollection,
    onOpenFullPage,
    onOpenPath,
    onRequestActors: loadActors,
    onCommitField: (entry, column, value) =>
      void commitField(entry, column, value),
  });

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function handleAddColumn(type: PropertyType) {
    const name = uniqueColumnName(schema, propertyTypeLabel(type));
    const next = await addCollectionColumn({
      spacePath,
      collectionPath,
      column: {
        name,
        type,
        relation: type === "relation" ? collectionPath || "." : undefined,
      },
      projectPath,
    });
    onSchemaChange(normalizeSchema(next));
    await updateViewPatch({ visible_fields: [...visibleFields, name] });
    setOpenColumn(name);
  }

  async function handleCreate(asFolder: boolean) {
    const title = composerValue.trim();
    if (!title) {
      setComposerOpen(false);
      setComposerAsFolder(false);
      return;
    }
    await onCreateEntry(title, asFolder || composerAsFolder);
    setComposerValue("");
    setComposerOpen(false);
    setComposerAsFolder(false);
    await loadEntries();
  }

  function openComposer(asFolder: boolean) {
    setComposerAsFolder(asFolder);
    setComposerOpen(true);
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (hasSort) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = filteredTopLevel.findIndex(
      (entry) => entry.path === active.id,
    );
    const newIndex = filteredTopLevel.findIndex(
      (entry) => entry.path === over.id,
    );
    if (oldIndex < 0 || newIndex < 0) return;
    const fullOrder = reorderVisibleEntries(
      topLevelEntries,
      filteredTopLevel,
      String(active.id),
      newIndex,
    );
    await saveTableOrder(spacePath, collectionPath, fullOrder, projectPath);
    setEntries((current) => {
      const children = current.filter(
        (entry) => entryParentDir(entry.path) !== collectionPath,
      );
      return [...fullOrder, ...children];
    });
    if (sidebarSpaceId) {
      await reloadTreeParent(sidebarSpaceId, collectionPath);
    }
  }

  if (loading) return <LoadingTable fields={visibleFields} schema={schema} />;
  if (error) return <ErrorState title={m.table_error_title()} />;

  const noRows = filteredTopLevel.length === 0;

  return (
    <div className={detailPageViewClassName}>
      <TableShell
        onKeyDown={(event) => {
          if (isEditableTarget(event.target)) return;
          if (event.ctrlKey && event.key.toLowerCase() === "n") {
            event.preventDefault();
            openComposer(event.shiftKey);
            return;
          }
        }}
      >
        <Table
          className="min-w-full table-auto"
          style={{ minWidth: table.getTotalSize() + 62, width: "100%" }}
        >
          <TableHeaderRow
            table={table}
            onAddColumn={(type) => void handleAddColumn(type)}
          />
          {noRows ? (
            <EmptyTableBody
              colSpan={visibleFields.length + 2}
              filtered={Boolean(searchQuery) || filters.length > 0}
              onCreate={() => openComposer(false)}
              onClearFilters={() => {
                onClearSearch?.();
                query.setLocalQuery({ filter: [] });
              }}
            />
          ) : (
            <TableRowsBody
              table={table}
              sensors={sensors}
              sortedEntries={filteredTopLevel}
              hasSort={hasSort}
              actors={actors}
              spacePath={spacePath}
              projectPath={projectPath}
              onOpenEntry={onOpenEntry}
              onOpenNestedPeek={onOpenNestedPeek ?? onOpenEntry}
              onOpenFullPage={onOpenFullPage}
              onOpenPath={onOpenPath}
              onDuplicateEntry={onDuplicateEntry}
              onDeleteEntry={onDeleteEntry}
              onDragEnd={(event) => void handleDragEnd(event)}
              density={density}
              wrapText={wrapText}
            />
          )}
          <TableFooterComposer
            colSpan={visibleFields.length + 2}
            entryCount={filteredTopLevel.length}
            footerRef={footerRef}
            inputRef={footerInputRef}
            open={composerOpen}
            value={composerValue}
            onOpen={openComposer}
            onCancel={() => {
              setComposerOpen(false);
              setComposerAsFolder(false);
            }}
            onValueChange={setComposerValue}
            onCreate={(asFolder) => void handleCreate(asFolder)}
          />
        </Table>
      </TableShell>
    </div>
  );
}
