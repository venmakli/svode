import { cn } from "@/lib/utils";
import { validatePropertyValue } from "@/features/properties/model";
import type { Entry } from "@/features/editor/types";
import type { Column, Person, RelationContext } from "@/features/properties/model";
import { isEmptyValue } from "@/features/properties/lib";
import { PropertyControl, PropertyValue } from "@/features/properties/ui";

export function BoardPropertyFlow({
  entry,
  columns,
  persons,
  relationContext,
  onRequestPersons,
  onUpdateField,
}: {
  entry: Entry;
  columns: Column[];
  persons: Person[];
  relationContext?: RelationContext;
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const rendered = columns
    .map((column) => (
      <BoardPropertyChip
        key={column.name}
        entry={entry}
        column={column}
        persons={persons}
        relationContext={relationContext}
        onRequestPersons={onRequestPersons}
        onUpdateField={onUpdateField}
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
  relationContext,
  onRequestPersons,
  onUpdateField,
}: {
  entry: Entry;
  column: Column;
  persons: Person[];
  relationContext?: RelationContext;
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const value = entry.meta.extra?.[column.name] ?? null;
  if (isEmptyValue(value) && column.type !== "checkbox") return null;

  const validation = validatePropertyValue(column, value);
  const interactive =
    (column.type === "person" || column.type === "relation") &&
    Boolean(onUpdateField);
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
        interactive &&
          "max-w-full px-0 [&_[data-slot=avatar]]:size-5 [&_[data-slot=button]]:h-6 [&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:rounded-md [&_[data-slot=button]]:px-1.5 [&_[data-slot=button]]:text-xs [&_[data-slot=button]]:font-normal",
      )}
      data-board-interactive={interactive || undefined}
      onPointerDown={interactive ? stopInteractivePropagation : undefined}
      onClick={interactive ? stopInteractivePropagation : undefined}
      onKeyDown={interactive ? stopInteractivePropagation : undefined}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1",
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

function stopInteractivePropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
