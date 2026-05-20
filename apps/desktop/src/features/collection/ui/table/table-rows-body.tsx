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
import type {
  CollectionSchema,
  Column,
  Person,
} from "@/features/properties/model";
import { SortableTableRow } from "./table-row";
import type { CollectionTableRow } from "./types";
import { PropertyValue } from "@/features/properties/ui";
import { isEmptyValue } from "@/features/properties/lib";
import { nestedPreviewFields } from "./utils";

export function TableRowsBody({
  table,
  sensors,
  sortedEntries,
  hasSort,
  persons,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenFullPage,
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
  persons: Person[];
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenFullPage: (entry: Entry) => void;
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
                rowHeightClassName={rowHeight}
                onOpen={() =>
                  original.nestedCollection
                    ? onOpenNestedPeek(original.entry)
                    : onOpenEntry(original.entry)
                }
                onOpenFullPage={() => onOpenFullPage(original.entry)}
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
                      persons={persons}
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
                    <TableCell className={cn(rowHeight, "p-0")} />
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
  persons,
}: {
  row: CollectionTableRow;
  schema: CollectionSchema;
  persons: Person[];
}) {
  const values = nestedPreviewFields(schema)
    .filter((field) => field !== "title")
    .map((field) => {
      const column = schema.columns.find((item) => item.name === field);
      if (!column) return null;
      const value = row.entry.meta.extra?.[column.name] ?? null;
      if (isEmptyValue(value)) return null;
      return { column, value };
    })
    .filter((item) => item !== null)
    .slice(0, 4);

  return (
    <div
      className="flex h-7 min-w-0 items-center gap-3 text-sm"
      style={{ paddingLeft: row.level * 18 }}
    >
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          values.length > 0 ? "max-w-[28rem] shrink" : "flex-1",
        )}
      >
        {row.entry.meta.icon ? `${row.entry.meta.icon} ` : ""}
        {row.entry.meta.title}
      </span>
      {values.length > 0 ? (
        <span className="h-4 w-px shrink-0 bg-border" />
      ) : null}
      {values.length > 0 ? (
        <span className="flex min-w-0 shrink items-center gap-3 text-xs">
          {values.map(({ column, value }) => (
            <span
              key={column.name}
              className={cn(
                "flex min-w-0 items-center text-muted-foreground",
                nestedPreviewValueClass(column),
              )}
            >
              <PropertyValue column={column} value={value} persons={persons} />
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function nestedPreviewValueClass(column: Column) {
  if (column.type === "number") {
    if (column.display === "bar") return "w-28 shrink-0";
    if (column.display === "ring") return "w-7 shrink-0";
    return "max-w-20 shrink truncate";
  }
  if (column.type === "date") return "max-w-64 shrink truncate";
  if (column.type === "person") return "max-w-44 shrink truncate";
  if (column.type === "multi_select") return "max-w-52 shrink truncate";
  if (column.type === "select" || column.type === "status") {
    return "shrink-0";
  }
  if (column.type === "checkbox") return "shrink-0";
  return "max-w-48 shrink truncate";
}
