import { cn } from "@/lib/utils";
import { validatePropertyValue } from "@/features/properties/model";
import { isEmptyValue, valueToString } from "@/features/properties/lib";
import { PropertyControl, PropertyValue } from "@/features/properties/ui";
import type { Entry } from "@/features/editor/types";
import type { Column, Person, RelationContext } from "@/features/properties/model";

export function CardPropertyFlow({
  entry,
  columns,
  persons,
  relationContext,
  className,
  mode = "card",
  onRequestPersons,
  onUpdateField,
}: {
  entry: Entry;
  columns: Column[];
  persons: Person[];
  relationContext?: RelationContext;
  className?: string;
  mode?: "card" | "inline";
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const rendered = columns
    .map((column) => (
      <CardPropertyItem
        key={column.name}
        entry={entry}
        column={column}
        persons={persons}
        relationContext={relationContext}
        mode={mode}
        onRequestPersons={onRequestPersons}
        onUpdateField={onUpdateField}
      />
    ))
    .filter(Boolean);

  if (rendered.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {rendered}
    </div>
  );
}

function CardPropertyItem({
  entry,
  column,
  persons,
  relationContext,
  mode,
  onRequestPersons,
  onUpdateField,
}: {
  entry: Entry;
  column: Column;
  persons: Person[];
  relationContext?: RelationContext;
  mode: "card" | "inline";
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const value = valueForColumn(entry, column);
  if (isEmptyValue(value) && column.type !== "checkbox") return null;

  const validation = validatePropertyValue(column, value);
  const interactive = Boolean(onUpdateField) && isInteractiveCardType(column);
  const fullWidth = mode === "card" && isFullWidthCardType(column);

  return (
    <div
      className={cn(
        "min-w-0 rounded-md px-0.5 text-left text-xs leading-tight",
        mode === "inline" && "max-w-44",
        fullWidth && "w-full",
        validation.invalid && "ring-1 ring-warning",
        interactive &&
          "max-w-full px-0 [&_[data-slot=avatar]]:size-5 [&_[data-slot=button]]:h-6 [&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:rounded-md [&_[data-slot=button]]:px-1.5 [&_[data-slot=button]]:text-xs [&_[data-slot=button]]:font-normal [&_[data-slot=checkbox]]:size-4 [&_[data-slot=input]]:h-6 [&_[data-slot=input]]:min-w-16 [&_[data-slot=input]]:rounded-md [&_[data-slot=input]]:px-1.5 [&_[data-slot=input]]:text-xs",
      )}
      data-card-interactive={interactive || undefined}
      onPointerDown={interactive ? stopInteractivePropagation : undefined}
      onClick={interactive ? stopInteractivePropagation : undefined}
      onKeyDown={interactive ? stopInteractivePropagation : undefined}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1",
          mode === "inline" && "truncate",
          fullWidth && "w-full truncate",
          column.type === "multi_select" && "flex-wrap",
        )}
      >
        {interactive ? (
          <PropertyControl
            column={column}
            value={value}
            invalid={validation.invalid}
            persons={persons}
            relationContext={relationContext}
            onRequestPersons={onRequestPersons}
            onChange={(next) => onUpdateField?.(entry, column, next)}
          />
        ) : (
          <PropertyValue
            column={column}
            value={value}
            persons={persons}
            relationContext={relationContext}
          />
        )}
      </span>
    </div>
  );
}

function valueForColumn(entry: Entry, column: Column) {
  if (column.name === "created") return entry.meta.created;
  if (column.name === "updated") return entry.meta.updated;
  const value = entry.meta.extra?.[column.name];
  return typeof value === "string" ? valueToString(value) : (value ?? null);
}

function isInteractiveCardType(column: Column) {
  return (
    column.type === "select" ||
    column.type === "multi_select" ||
    column.type === "status" ||
    column.type === "date" ||
    column.type === "person" ||
    column.type === "relation" ||
    column.type === "checkbox"
  );
}

function isFullWidthCardType(column: Column) {
  return (
    (column.type === "number" && column.display === "bar") ||
    column.type === "text" ||
    column.type === "url" ||
    column.type === "email" ||
    column.type === "phone"
  );
}

function stopInteractivePropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
