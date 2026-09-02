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
import { useCallback, useRef } from "react";
import { flexRender, type Table as ReactTable } from "@tanstack/react-table";
import { TableBody, TableCell } from "@/components/ui/table";
import { cn } from "@/shared/lib/utils";
import type { Page } from "@/features/page";
import type {
  CollectionSchema,
  Column,
  ActorCandidate,
  RelationOpenTarget,
} from "@/features/properties";
import { SortableTableRow } from "./table-row";
import type { CollectionTableRow } from "./types";
import { PropertyValue } from "@/features/properties/display";
import { isEmptyValue } from "@/features/properties";
import { nestedPreviewFields } from "./utils";

export function TableRowsBody({
  table,
  sensors,
  sortedEntries,
  hasSort,
  readOnly,
  actors,
  spacePath,
  projectPath,
  onActivateItem,
  onOpenNestedPeek,
  focusedPath,
  onFocusRow,
  onOpenPath,
  onOpenRelationTarget,
  onDuplicatePage,
  onDeletePage,
  onDragEnd,
  density = "default",
  wrapText = false,
}: {
  table: ReactTable<CollectionTableRow>;
  sensors: ReturnType<typeof useSensors> | undefined;
  sortedEntries: Page[];
  hasSort: boolean;
  readOnly: boolean;
  actors: ActorCandidate[];
  spacePath: string;
  projectPath?: string | null;
  onActivateItem: (page: Page) => void;
  onOpenNestedPeek: (entry: Page) => void;
  focusedPath: string | null;
  onFocusRow: (path: string) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
  onDuplicatePage: (page: Page) => void;
  onDeletePage: (page: Page) => void;
  onDragEnd: (event: DragEndEvent) => void;
  density?: "compact" | "default" | "spacious";
  wrapText?: boolean;
}) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const visibleRows = table.getRowModel().rows;
  const moveFocus = useCallback(
    (path: string, key: string) => {
      const currentIndex = visibleRows.findIndex(
        (row) => row.original.entry.path === path,
      );
      if (currentIndex < 0) return;
      const nextIndex =
        key === "Home"
          ? 0
          : key === "End"
            ? visibleRows.length - 1
            : Math.max(
                0,
                Math.min(
                  visibleRows.length - 1,
                  currentIndex + (key === "ArrowUp" ? -1 : 1),
                ),
              );
      const nextPath = visibleRows[nextIndex]?.original.entry.path;
      if (!nextPath) return;
      onFocusRow(nextPath);
      rowRefs.current.get(nextPath)?.focus();
    },
    [onFocusRow, visibleRows],
  );
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
      sensors={hasSort || readOnly ? undefined : sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={sortedEntries.map((entry) => entry.path)}
        strategy={verticalListSortingStrategy}
      >
        <TableBody>
          {visibleRows.map((row, index) => {
            const original = row.original;
            const path = original.entry.path;
            const selected = focusedPath === path;
            return (
              <SortableTableRow
                key={path}
                row={original}
                disabled={readOnly || hasSort || original.child}
                readOnly={readOnly}
                rowHeightClassName={rowHeight}
                selected={selected}
                tabIndex={selected || (!focusedPath && index === 0) ? 0 : -1}
                onOpen={() =>
                  original.nestedCollection
                    ? onOpenNestedPeek(original.entry)
                    : onActivateItem(original.entry)
                }
                onFocus={() => onFocusRow(path)}
                onMoveFocus={(key) => moveFocus(path, key)}
                registerRow={(element) => {
                  if (element) rowRefs.current.set(path, element);
                  else rowRefs.current.delete(path);
                }}
                onDuplicate={() => onDuplicatePage(original.entry)}
                onDelete={() => onDeletePage(original.entry)}
              >
                {original.nestedSchema ? (
                  <TableCell
                    className={cellClassName}
                    colSpan={table.getVisibleLeafColumns().length + 1}
                  >
                    <NestedSchemaPreview
                      row={original}
                      schema={original.nestedSchema}
                      actors={actors}
                      spacePath={spacePath}
                      projectPath={projectPath}
                      onOpenPath={onOpenPath}
                      onOpenRelationTarget={onOpenRelationTarget}
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
  actors,
  spacePath,
  projectPath,
  onOpenPath,
  onOpenRelationTarget,
}: {
  row: CollectionTableRow;
  schema: CollectionSchema;
  actors: ActorCandidate[];
  spacePath: string;
  projectPath?: string | null;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
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
          values.length > 0 ? "max-w-md shrink" : "flex-1",
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
              <PropertyValue
                column={column}
                value={value}
                actors={actors}
                relationContext={{
                  spacePath,
                  projectPath,
                  currentFilePath: row.entry.path,
                  onOpenPath,
                  onOpenRelationTarget,
                }}
              />
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
  if (column.type === "actor") {
    return "max-w-44 shrink truncate";
  }
  if (column.type === "multi_select") return "max-w-52 shrink truncate";
  if (column.type === "select" || column.type === "status") {
    return "shrink-0";
  }
  if (column.type === "boolean") return "shrink-0";
  return "max-w-48 shrink truncate";
}
