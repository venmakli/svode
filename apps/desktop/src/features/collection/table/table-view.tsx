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
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Table } from "@/components/ui/table";
import type { CollectionView } from "@/features/collection-query/types";
import type { Entry } from "@/features/editor/types";
import { normalizeSchema } from "@/features/properties/utils";
import type {
  CollectionSchema,
  Column,
  Person,
  PropertyType,
} from "@/features/properties/types";
import { titleFilter } from "../utils";
import { isEditableTarget } from "../utils";
import { usePersistentSet, usePersistentSizing } from "./persistence";
import { propertyTypeLabel } from "./property-type-picker";
import { EmptyTableBody } from "./table-empty-state";
import { TableFooterComposer } from "./table-footer-composer";
import { TableHeaderRow } from "./table-header-row";
import { TableRowsBody } from "./table-rows-body";
import { ErrorState, LoadingTable, TableShell } from "./table-shell";
import type { CollectionInfo, TableEditingCell, TableViewProps } from "./types";
import { useTableColumns } from "./use-table-columns";
import {
  entryParentDir,
  entryCollectionPath,
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
  onDuplicateEntry,
  onDeleteEntry,
  onSchemaChange,
  onUpdateView,
  onCreateEntry,
}: TableViewProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [persons, setPersons] = useState<Person[]>([]);
  const [nestedCollectionPaths, setNestedCollectionPaths] = useState<
    Set<string>
  >(new Set());
  const [nestedSchemas, setNestedSchemas] = useState<
    Map<string, CollectionSchema>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TableEditingCell | null>(null);
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
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
    `combai:table-expanded:${spacePath}:${collectionPath}:${name}`,
  );
  const [columnSizing, setColumnSizing] = usePersistentSizing(
    `combai:table-column-widths:${spacePath}:${collectionPath}`,
  );
  const footerInputRef = useRef<HTMLInputElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);

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
  const hasPersonColumn = useMemo(
    () => schema.columns.some((column) => column.type === "person"),
    [schema.columns],
  );

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [baseEntries, collections] = await Promise.all([
        invoke<Entry[]>("query_entries", {
          space: spacePath,
          collectionPath,
          filters,
          sort,
          includeNested: showNested,
          limit: null,
          offset: null,
          projectPath: projectPath ?? null,
        }),
        invoke<CollectionInfo[]>("list_collections", {
          space: spacePath,
        }).catch(() => []),
      ]);
      const collectionPaths = new Set(collections.map((item) => item.path));
      setNestedCollectionPaths(collectionPaths);
      const schemaPairs = await Promise.all(
        collections
          .filter((item) => item.path !== collectionPath)
          .map(async (item) => {
            try {
              const nestedSchema = await invoke<CollectionSchema>(
                "get_collection_schema",
                {
                  space: spacePath,
                  collectionPath: item.path,
                },
              );
              return [item.path, normalizeSchema(nestedSchema)] as const;
            } catch {
              return null;
            }
          }),
      );
      const nextNestedSchemas = new Map(
        schemaPairs.filter((item) => item !== null),
      );
      const nestedParentPaths = Array.from(
        new Set(
          baseEntries
            .map((entry) => entryCollectionPath(entry))
            .filter(
              (path) => path !== collectionPath && collectionPaths.has(path),
            ),
        ),
      );
      const nestedEntryBatches = await Promise.all(
        nestedParentPaths.map(async (nestedPath) => {
          const nestedSchema = nextNestedSchemas.get(nestedPath);
          const nestedTableView = ((nestedSchema?.views ?? []) as CollectionView[])
            .find((item) => item?.type === "table");
          try {
            return await invoke<Entry[]>("query_entries", {
              space: spacePath,
              collectionPath: nestedPath,
              filters: nestedTableView?.filter ?? null,
              sort: nestedTableView?.sort ?? null,
              includeNested: nestedTableView
                ? showNestedForView(nestedTableView)
                : true,
              limit: null,
              offset: null,
              projectPath: projectPath ?? null,
            });
          } catch (nestedLoadError) {
            console.warn("Failed to load nested table entries:", nestedLoadError);
            return [];
          }
        }),
      );
      const entriesByPath = new Map<string, Entry>();
      [...baseEntries, ...nestedEntryBatches.flat()].forEach((entry) => {
        entriesByPath.set(entry.path, entry);
      });
      setEntries(Array.from(entriesByPath.values()));
      setNestedSchemas(nextNestedSchemas);
    } catch (loadError) {
      console.warn("Failed to load table entries:", loadError);
      toast.error(m.table_error_title());
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, [collectionPath, filters, projectPath, showNested, sort, spacePath]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, refreshToken]);

  const loadPersons = useCallback(
    async (allTime = false) => {
      const list = await invoke<Person[]>("list_persons", {
        spacePath,
        allTime,
      });
      setPersons(list);
      return list;
    },
    [spacePath],
  );

  useEffect(() => {
    if (!hasPersonColumn) return;
    void loadPersons().catch((loadError) => {
      console.warn("Failed to load table persons:", loadError);
    });
  }, [hasPersonColumn, loadPersons]);

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

  const commitField = useCallback(
    async (entry: Entry, column: Column, value: unknown) => {
      setEntries((current) =>
        current.map((item) =>
          item.path === entry.path
            ? {
                ...item,
                meta: {
                  ...item.meta,
                  extra: { ...item.meta.extra, [column.name]: value },
                },
              }
            : item,
        ),
      );
      try {
        const updated = await invoke<Entry>("update_entry_field", {
          space: spacePath,
          filePath: entry.path,
          field: column.name,
          value,
          projectPath: projectPath ?? null,
        });
        setEntries((current) =>
          current.map((item) => (item.path === entry.path ? updated : item)),
        );
      } catch (saveError) {
        console.warn("Failed to update table field:", saveError);
        void loadEntries();
      }
    },
    [loadEntries, projectPath, spacePath],
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
    persons,
    setEditing,
    setOpenColumn,
    setExpanded,
    onSchemaChange,
    onUpdateViewPatch: updateViewPatch,
    onOpenEntry,
    onOpenNestedPeek: onOpenNestedPeek ?? onOpenEntry,
    onOpenNestedCollection,
    onRequestPersons: loadPersons,
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
    const next = await invoke<CollectionSchema>("add_schema_column", {
      space: spacePath,
      collectionPath,
      column: { name, type },
      projectPath: projectPath ?? null,
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
    const created = await onCreateEntry(title, asFolder || composerAsFolder);
    setComposerValue("");
    setComposerOpen(false);
    setComposerAsFolder(false);
    setFocusedPath(created.path);
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
  }

  if (loading) return <LoadingTable fields={visibleFields} schema={schema} />;
  if (error) return <ErrorState title={m.table_error_title()} />;

  const noRows = filteredTopLevel.length === 0;
  const focusedEntry =
    rows.find((row) => row.entry.path === focusedPath)?.entry ?? null;

  function focusRow(path: string | null) {
    if (!path) return;
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-table-row-path="${CSS.escape(path)}"]`,
        )
        ?.focus();
    });
  }

  function moveFocused(direction: 1 | -1) {
    if (filteredTopLevel.length === 0) return;
    const current = focusedPath
      ? filteredTopLevel.findIndex((entry) => entry.path === focusedPath)
      : -1;
    const nextIndex =
      current < 0
        ? 0
        : Math.max(
            0,
            Math.min(filteredTopLevel.length - 1, current + direction),
          );
    const nextPath = filteredTopLevel[nextIndex]?.path ?? null;
    setFocusedPath(nextPath);
    focusRow(nextPath);
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pb-4 pt-3">
      <TableShell
        onKeyDown={(event) => {
          if (isEditableTarget(event.target)) return;
          if (event.ctrlKey && event.key.toLowerCase() === "n") {
            event.preventDefault();
            openComposer(event.shiftKey);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveFocused(event.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (event.key === "Enter" && focusedEntry) {
            event.preventDefault();
            if (nestedCollectionPaths.has(entryCollectionPath(focusedEntry))) {
              (onOpenNestedPeek ?? onOpenEntry)(focusedEntry);
            } else {
              onOpenEntry(focusedEntry);
            }
            return;
          }
          if (
            (event.key === "Delete" || event.key === "Backspace") &&
            focusedEntry
          ) {
            event.preventDefault();
            onDeleteEntry(focusedEntry);
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
              focusedPath={focusedPath}
              onFocusPath={setFocusedPath}
              onOpenEntry={onOpenEntry}
              onOpenNestedPeek={onOpenNestedPeek ?? onOpenEntry}
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
