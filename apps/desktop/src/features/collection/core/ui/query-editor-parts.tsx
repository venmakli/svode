import { Check, Plus, Trash2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PaneRow } from "@/features/collection/query/ui";
import type { CollectionPropertyDefinition } from "@/features/properties";

import type { ControlledQueryDraft } from "../../query/hooks";
import { isCollectionCoreFilterDraftValid } from "../model/query";
import type {
  CollectionCoreFilterRule,
  CollectionCorePresentationDescriptor,
  CollectionCoreQueryState,
} from "../model/types";

export function hasCollectionCoreSort<Row>(
  property: CollectionPropertyDefinition<Row>,
): boolean {
  return Boolean(
    property.capabilities?.sort &&
    (property.capabilities.sort.kind === "custom" ||
      property.semantics.kind === "standard"),
  );
}

export function propertyByKey<Row>(
  descriptor: CollectionCorePresentationDescriptor<Row>,
  propertyKey: string,
): CollectionPropertyDefinition<Row> | undefined {
  return descriptor.properties.find((property) => property.key === propertyKey);
}

export function propertyLabel<Row>(
  descriptor: CollectionCorePresentationDescriptor<Row>,
  propertyKey: string,
): string {
  return propertyByKey(descriptor, propertyKey)?.label ?? propertyKey;
}

export function isFilterDraftValid<Row>(
  descriptor: CollectionCorePresentationDescriptor<Row>,
  value: CollectionCoreQueryState,
  draft: ControlledQueryDraft<CollectionCoreFilterRule> | null,
): boolean {
  return isCollectionCoreFilterDraftValid(descriptor, value, draft);
}

export function CollectionCorePropertyChoiceList<Row>({
  properties,
  icon,
  onSelect,
}: {
  properties: readonly CollectionPropertyDefinition<Row>[];
  icon: LucideIcon;
  onSelect(property: CollectionPropertyDefinition<Row>): void;
}) {
  return (
    <div className="flex max-h-64 flex-col overflow-y-auto p-1">
      {properties.map((property) => (
        <PaneRow
          key={property.key}
          icon={icon}
          label={property.label}
          onClick={() => onSelect(property)}
        />
      ))}
    </div>
  );
}

export function QueryAddButton({
  label,
  onClick,
}: {
  label: string;
  onClick(): void;
}) {
  return (
    <Button
      type="button"
      className="h-9 w-full justify-start px-2 text-sm font-normal"
      size="default"
      variant="ghost"
      onClick={onClick}
    >
      <Plus data-icon="inline-start" />
      {label}
    </Button>
  );
}

export function QueryEditorFooter({
  applyDisabled = false,
  applyLabel,
  deleteLabel,
  onApply,
  onDelete,
}: {
  applyDisabled?: boolean;
  applyLabel: string;
  deleteLabel: string;
  onApply(): void;
  onDelete(): void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        className="w-full justify-start"
        disabled={applyDisabled}
        onClick={onApply}
      >
        <Check data-icon="inline-start" />
        {applyLabel}
      </Button>
      <Button
        type="button"
        className="w-full justify-start"
        variant="ghost"
        onClick={onDelete}
      >
        <Trash2 data-icon="inline-start" />
        {deleteLabel}
      </Button>
    </div>
  );
}
