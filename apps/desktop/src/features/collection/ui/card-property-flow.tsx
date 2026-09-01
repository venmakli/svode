import { cn } from "@/shared/lib/utils";
import {
  isEmptyValue,
  resolveStandardPropertyColumn,
  validatePropertyValue,
} from "@/features/properties";
import { PropertyControl } from "@/features/properties/control";
import { PropertyValue } from "@/features/properties/display";
import type { Page } from "@/features/page";
import type {
  Column,
  ActorCandidate,
  CollectionPropertyDefinition,
  RelationContext,
} from "@/features/properties";

import {
  CollectionPresentationPropertyFlow,
  CollectionPresentationPropertyItem,
} from "./presentation-chrome";

export function CardPropertyFlow({
  entry,
  properties,
  actors,
  relationContext,
  className,
  mode = "card",
  onRequestActors,
  onUpdateField,
}: {
  entry: Page;
  properties: readonly CollectionPropertyDefinition<Page>[];
  actors: ActorCandidate[];
  relationContext?: RelationContext;
  className?: string;
  mode?: "card" | "inline";
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Page, column: Column, value: unknown) => void;
}) {
  const rendered = properties
    .map((property) => (
      <CardPropertyItem
        key={property.key}
        entry={entry}
        property={property}
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
    <CollectionPresentationPropertyFlow
      className={cn("justify-start gap-1.5 overflow-visible", className)}
    >
      {rendered}
    </CollectionPresentationPropertyFlow>
  );
}

function CardPropertyItem({
  entry,
  property,
  actors,
  relationContext,
  mode,
  onRequestActors,
  onUpdateField,
}: {
  entry: Page;
  property: CollectionPropertyDefinition<Page>;
  actors: ActorCandidate[];
  relationContext?: RelationContext;
  mode: "card" | "inline";
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Page, column: Column, value: unknown) => void;
}) {
  const standardColumn = resolveStandardPropertyColumn(property);
  const value = property.getValue(entry);
  if (!standardColumn) return null;
  if (isEmptyValue(value) && standardColumn.type !== "boolean") return null;

  const validation = validatePropertyValue(standardColumn, value);
  const interactive =
    Boolean(onUpdateField) && isInteractiveCardType(standardColumn);
  const fullWidth = mode === "card" && isFullWidthCardType(standardColumn);

  return (
    <CollectionPresentationPropertyItem
      className={cn(
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
          standardColumn.type === "multi_select" && "flex-wrap",
        )}
      >
        {interactive ? (
          <PropertyControl
            column={standardColumn}
            value={value}
            invalid={validation.invalid}
            accessibilityLabel={
              property.getAccessibilityLabel?.(entry) ??
              `${property.label}: ${entry.meta.title}`
            }
            density="compact"
            actors={actors}
            relationContext={relationContext}
            onRequestActors={onRequestActors}
            onChange={(next) =>
              void onUpdateField?.(entry, standardColumn, next)
            }
          />
        ) : (
          <PropertyValue
            column={standardColumn}
            value={value}
            actors={actors}
            relationContext={relationContext}
          />
        )}
      </span>
    </CollectionPresentationPropertyItem>
  );
}

function isInteractiveCardType(column: Column) {
  return (
    column.type === "select" ||
    column.type === "multi_select" ||
    column.type === "status" ||
    column.type === "date" ||
    column.type === "actor" ||
    column.type === "relation" ||
    column.type === "boolean"
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
