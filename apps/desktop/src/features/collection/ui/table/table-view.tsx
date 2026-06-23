import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Table } from "@/components/ui/table";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import { isEditableTarget } from "../../lib/utils";
import { useTableViewRuntime } from "../../hooks/table/use-table-view-runtime";
import { EmptyTableBody } from "./table-empty-state";
import { TableFooterComposer } from "./table-footer-composer";
import { TableHeaderRow } from "./table-header-row";
import { TableRowsBody } from "./table-rows-body";
import { ErrorState, LoadingTable, TableShell } from "./table-shell";
import type { TableViewProps } from "./types";
import { useTableColumns } from "./use-table-columns";
import * as m from "@/paraglide/messages.js";

export function TableView(props: TableViewProps) {
  const {
    view,
    query,
    schema,
    collectionPath,
    spacePath,
    projectPath,
    searchQuery,
    filters,
    onClearSearch,
    onOpenEntry,
    onOpenNestedPeek,
    onOpenNestedCollection,
    onOpenFullPage,
    onOpenPath,
    onDuplicateEntry,
    onDeleteEntry,
    onSchemaChange,
  } = props;
  const runtime = useTableViewRuntime(props);

  const tableColumns = useTableColumns({
    visibleFields: runtime.visibleFields,
    schema,
    view,
    query,
    collectionPath,
    spacePath,
    projectPath,
    columnSizing: runtime.columnSizing,
    editing: runtime.editing,
    openColumn: runtime.openColumn,
    entries: runtime.entries,
    expanded: runtime.expanded,
    nestedCollectionPaths: runtime.nestedCollectionPaths,
    showNested: runtime.showNested,
    actors: runtime.actors,
    setEditing: runtime.setEditing,
    setOpenColumn: runtime.setOpenColumn,
    setExpanded: runtime.setExpanded,
    onSchemaChange,
    onUpdateViewPatch: runtime.updateViewPatch,
    onOpenEntry,
    onOpenNestedPeek: onOpenNestedPeek ?? onOpenEntry,
    onOpenNestedCollection,
    onOpenFullPage,
    onOpenPath,
    onRequestActors: runtime.loadActors,
    onCommitField: (entry, column, value) =>
      void runtime.commitField(entry, column, value),
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table intentionally returns an imperative table instance for this view.
  const table = useReactTable({
    data: runtime.rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    state: { columnSizing: runtime.columnSizing },
    onColumnSizingChange: runtime.setColumnSizing,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (runtime.loading) {
    return <LoadingTable fields={runtime.visibleFields} schema={schema} />;
  }
  if (runtime.error) return <ErrorState title={m.table_error_title()} />;

  const noRows = runtime.filteredTopLevel.length === 0;

  return (
    <div className={detailPageViewClassName}>
      <TableShell
        onKeyDown={(event) => {
          if (isEditableTarget(event.target)) return;
          if (event.ctrlKey && event.key.toLowerCase() === "n") {
            event.preventDefault();
            runtime.openComposer(event.shiftKey);
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
            onAddColumn={(type) => void runtime.handleAddColumn(type)}
          />
          {noRows ? (
            <EmptyTableBody
              colSpan={runtime.visibleFields.length + 2}
              filtered={Boolean(searchQuery) || filters.length > 0}
              onCreate={() => runtime.openComposer(false)}
              onClearFilters={() => {
                onClearSearch?.();
                query.setLocalQuery({ filter: [] });
              }}
            />
          ) : (
            <TableRowsBody
              table={table}
              sensors={sensors}
              sortedEntries={runtime.filteredTopLevel}
              hasSort={runtime.hasSort}
              actors={runtime.actors}
              spacePath={spacePath}
              projectPath={projectPath}
              onOpenEntry={onOpenEntry}
              onOpenNestedPeek={onOpenNestedPeek ?? onOpenEntry}
              onOpenFullPage={onOpenFullPage}
              onOpenPath={onOpenPath}
              onDuplicateEntry={onDuplicateEntry}
              onDeleteEntry={onDeleteEntry}
              onDragEnd={(event) => void runtime.handleDragEnd(event)}
              density={runtime.density}
              wrapText={runtime.wrapText}
            />
          )}
          <TableFooterComposer
            colSpan={runtime.visibleFields.length + 2}
            entryCount={runtime.filteredTopLevel.length}
            footerRef={runtime.footerRef}
            inputRef={runtime.footerInputRef}
            open={runtime.composerOpen}
            value={runtime.composerValue}
            onOpen={runtime.openComposer}
            onCancel={runtime.cancelComposer}
            onValueChange={runtime.setComposerValue}
            onCreate={(asFolder) => void runtime.handleCreate(asFolder)}
          />
        </Table>
      </TableShell>
    </div>
  );
}
