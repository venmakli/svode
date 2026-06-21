import { cn } from "@/shared/lib/utils";
import { validatePropertyValue } from "@/features/properties";
import type { Entry } from "@/features/entry";
import type {
  Column,
  ActorCandidate,
  RelationContext,
} from "@/features/properties";
import { isEmptyValue } from "@/features/properties";
import { PropertyControl, PropertyValue } from "@/features/properties";

export function BoardPropertyFlow({
  entry,
  columns,
  actors,
  relationContext,
  onRequestActors,
  onUpdateField,
}: {
  entry: Entry;
  columns: Column[];
  actors: ActorCandidate[];
  relationContext?: RelationContext;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const rendered = columns
    .map((column) => (
      <BoardPropertyChip
        key={column.name}
        entry={entry}
        column={column}
        actors={actors}
        relationContext={relationContext}
        onRequestActors={onRequestActors}
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
  actors,
  relationContext,
  onRequestActors,
  onUpdateField,
}: {
  entry: Entry;
  column: Column;
  actors: ActorCandidate[];
  relationContext?: RelationContext;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
}) {
  const value = entry.meta.extra?.[column.name] ?? null;
  if (isEmptyValue(value) && column.type !== "checkbox") return null;

  const validation = validatePropertyValue(column, value);
  const interactive =
    (column.type === "actor" || column.type === "relation") &&
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

function stopInteractivePropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
