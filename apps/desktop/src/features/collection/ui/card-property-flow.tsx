import { cn } from "@/shared/lib/utils";
import { validatePropertyValue } from "@/features/properties";
import { isEmptyValue, valueToString } from "@/features/properties";
import { PropertyControl, PropertyValue } from "@/features/properties/ui";
import type { Entry } from "@/features/entry";
import type {
  Column,
  ActorCandidate,
  RelationContext,
} from "@/features/properties";

export function CardPropertyFlow({
  entry,
  columns,
  actors,
  relationContext,
  className,
  mode = "card",
  onRequestActors,
  onUpdateField,
}: {
  entry: Entry;
  columns: Column[];
  actors: ActorCandidate[];
  relationContext?: RelationContext;
  className?: string;
  mode?: "card" | "inline";
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const rendered = columns
    .map((column) => (
      <CardPropertyItem
        key={column.name}
        entry={entry}
        column={column}
        actors={actors}
        relationContext={relationContext}
        mode={mode}
        onRequestActors={onRequestActors}
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
  actors,
  relationContext,
  mode,
  onRequestActors,
  onUpdateField,
}: {
  entry: Entry;
  column: Column;
  actors: ActorCandidate[];
  relationContext?: RelationContext;
  mode: "card" | "inline";
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
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
            actors={actors}
            relationContext={relationContext}
            onRequestActors={onRequestActors}
            onChange={(next) => onUpdateField?.(entry, column, next)}
          />
        ) : (
          <PropertyValue
            column={column}
            value={value}
            actors={actors}
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
    column.type === "actor" ||
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
