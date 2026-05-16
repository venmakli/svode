import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  PropertyControl,
  validatePropertyValue,
} from "@/features/properties/property-control";
import type { Entry } from "@/features/editor/types";
import type { Column, Person } from "@/features/properties/types";
import { isEmptyValue } from "@/features/properties/utils";
import { PropertyValue } from "../table/cell-value";

export function BoardPropertyFlow({
  entry,
  columns,
  persons,
  onRequestPersons,
  onCommitField,
}: {
  entry: Entry;
  columns: Column[];
  persons: Person[];
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onCommitField: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const rendered = columns
    .map((column) => (
      <BoardPropertyChip
        key={column.name}
        entry={entry}
        column={column}
        persons={persons}
        onRequestPersons={onRequestPersons}
        onCommitField={onCommitField}
      />
    ))
    .filter(Boolean);

  if (rendered.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{rendered}</div>;
}

function BoardPropertyChip({
  entry,
  column,
  persons,
  onRequestPersons,
  onCommitField,
}: {
  entry: Entry;
  column: Column;
  persons: Person[];
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onCommitField: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const value = entry.meta.extra?.[column.name] ?? null;
  if (isEmptyValue(value) && column.type !== "checkbox") return null;

  const validation = validatePropertyValue(column, value);
  const fullWidth =
    (column.type === "number" && column.display === "bar") ||
    column.type === "text" ||
    column.type === "url" ||
    column.type === "email" ||
    column.type === "phone";

  if (column.type === "checkbox") {
    return (
      <button
        type="button"
        data-board-interactive
        className={cn(
          "inline-flex h-6 items-center rounded-md px-1.5 text-xs hover:bg-accent",
          !value && "text-muted-foreground",
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onCommitField(entry, column, !value);
        }}
      >
        <PropertyValue column={column} value={value} />
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-board-interactive
          className={cn(
            "min-w-0 rounded-md px-0.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            fullWidth && "w-full",
            validation.invalid && "ring-1 ring-warning",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
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
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <PropertyControl
          column={column}
          value={value}
          invalid={validation.invalid}
          persons={persons}
          onRequestPersons={onRequestPersons}
          onChange={(next) => onCommitField(entry, column, next)}
        />
      </PopoverContent>
    </Popover>
  );
}
