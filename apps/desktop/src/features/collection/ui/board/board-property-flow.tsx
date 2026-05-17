import { cn } from "@/lib/utils";
import { validatePropertyValue } from "@/features/properties/model";
import type { Entry } from "@/features/editor/types";
import type { Column } from "@/features/properties/model";
import { isEmptyValue } from "@/features/properties/lib";
import { PropertyValue } from "@/features/properties/ui";

export function BoardPropertyFlow({
  entry,
  columns,
}: {
  entry: Entry;
  columns: Column[];
}) {
  const rendered = columns
    .map((column) => (
      <BoardPropertyChip
        key={column.name}
        entry={entry}
        column={column}
      />
    ))
    .filter(Boolean);

  if (rendered.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{rendered}</div>;
}

function BoardPropertyChip({
  entry,
  column,
}: {
  entry: Entry;
  column: Column;
}) {
  const value = entry.meta.extra?.[column.name] ?? null;
  if (isEmptyValue(value) && column.type !== "checkbox") return null;

  const validation = validatePropertyValue(column, value);
  const fullWidth =
    (column.type === "number" && column.display === "bar") ||
    column.type === "text" ||
    column.type === "url" ||
    column.type === "email" ||
    column.type === "phone";

  return (
    <div
      className={cn(
        "min-w-0 rounded-md px-0.5 text-left text-xs",
        fullWidth && "w-full",
        validation.invalid && "ring-1 ring-warning",
      )}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1",
          fullWidth && "w-full truncate",
          column.type === "multi_select" && "flex-wrap",
        )}
      >
        <PropertyValue column={column} value={value} />
      </span>
    </div>
  );
}
