import {
  closestCenter,
  DndContext,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { flexRender, type Table as ReactTable } from "@tanstack/react-table";
import { TableBody, TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Entry } from "@/features/editor/types";
import type { CollectionSchema } from "@/features/properties/types";
import { SortableTableRow } from "./table-row";
import type { CollectionTableRow } from "./types";
import { PropertyValue } from "./cell-value";
import { nestedPreviewFields } from "./utils";

export function TableRowsBody({
  table,
  sensors,
  sortedEntries,
  hasSort,
  focusedPath,
  onFocusPath,
  onOpenEntry,
  onOpenNestedPeek,
  onDuplicateEntry,
  onDeleteEntry,
  onDragEnd,
  density = "default",
  wrapText = false,
}: {
  table: ReactTable<CollectionTableRow>;
  sensors: ReturnType<typeof useSensors> | undefined;
  sortedEntries: Entry[];
  hasSort: boolean;
  focusedPath: string | null;
  onFocusPath: (path: string) => void;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onDragEnd: (event: DragEndEvent) => void;
  density?: "compact" | "default" | "spacious";
  wrapText?: boolean;
}) {
  const rowHeight =
    density === "compact"
      ? "h-[30px]"
      : density === "spacious"
        ? "h-11"
        : "h-9";
  const cellClassName = cn(
    rowHeight,
    "border-r px-2 py-0",
    wrapText ? "whitespace-normal align-top py-1" : "whitespace-nowrap",
  );
  return (
    <DndContext
      sensors={hasSort ? undefined : sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={sortedEntries.map((entry) => entry.path)}
        strategy={verticalListSortingStrategy}
      >
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            const original = row.original;
            return (
              <SortableTableRow
                key={original.entry.path}
                row={original}
                disabled={hasSort || original.child}
                focused={focusedPath === original.entry.path}
                rowHeightClassName={rowHeight}
                onFocus={() => onFocusPath(original.entry.path)}
                onOpen={() =>
                  original.nestedCollection
                    ? onOpenNestedPeek(original.entry)
                    : onOpenEntry(original.entry)
                }
                onDuplicate={() => onDuplicateEntry(original.entry)}
                onDelete={() => onDeleteEntry(original.entry)}
              >
                {original.nestedSchema ? (
                  <TableCell
                    className={cellClassName}
                    colSpan={table.getVisibleLeafColumns().length + 1}
                  >
                    <NestedSchemaPreview
                      row={original}
                      schema={original.nestedSchema}
                    />
                  </TableCell>
                ) : (
                  <>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cellClassName}
                        style={{ width: cell.column.getSize() }}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                    <TableCell className={cn(rowHeight, "w-11 p-0")} />
                  </>
                )}
              </SortableTableRow>
            );
          })}
        </TableBody>
      </SortableContext>
    </DndContext>
  );
}

function NestedSchemaPreview({
  row,
  schema,
}: {
  row: CollectionTableRow;
  schema: CollectionSchema;
}) {
  const fields = nestedPreviewFields(schema).filter(
    (field) => field !== "title",
  );
  return (
    <div
      className="flex h-7 min-w-0 items-center gap-3 text-sm"
      style={{ paddingLeft: row.level * 18 }}
    >
      <span className="min-w-0 max-w-64 truncate font-medium">
        {row.entry.meta.icon ? `${row.entry.meta.icon} ` : ""}
        {row.entry.meta.title}
      </span>
      {fields.slice(0, 4).map((field) => {
        const column = schema.columns.find((item) => item.name === field);
        if (!column) return null;
        return (
          <span key={field} className="flex min-w-0 items-center gap-1 text-xs">
            <span className="text-muted-foreground">{field}</span>
            <span className="min-w-0 truncate">
              <PropertyValue
                column={column}
                value={row.entry.meta.extra?.[column.name] ?? null}
              />
            </span>
          </span>
        );
      })}
    </div>
  );
}
