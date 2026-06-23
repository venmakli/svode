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
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import type { PropertyType } from "@/features/properties";
import {
  useCollectionActors,
  useCollectionColumnActions,
  useCollectionEntryFieldSave,
} from "../../hooks";
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
import { useTableEntries } from "../../hooks/table/use-table-entries";
import {
  entryParentDir,
  flattenRows,
  normalizeVisibleFields,
  showNestedForView,
} from "./utils";
import { useTableEntryActions } from "../../hooks/table/use-table-entry-actions";
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
    setComposerOpen(true);
    setComposerAsFolder(createAsFolder);
    window.requestAnimationFrame(() => {
      footerRef.current?.scrollIntoView({ block: "nearest" });
      footerInputRef.current?.focus();
    });
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

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table intentionally returns an imperative table instance for this view.
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
    const { name } = await addColumn({
      type,
      baseName: propertyTypeLabel(type),
      relation: type === "relation" ? collectionPath || "." : undefined,
    });
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
    await createEntry(title, asFolder || composerAsFolder, () => {
      setComposerValue("");
      setComposerOpen(false);
      setComposerAsFolder(false);
    });
  }

  function openComposer(asFolder: boolean) {
    setComposerAsFolder(asFolder);
    setComposerOpen(true);
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (hasSort) return;
    await reorderEntries(event);
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
