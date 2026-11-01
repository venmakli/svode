import { Check, Plus, Trash2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PaneRow } from "@/features/collection/query/ui";
import type { CollectionPropertyDefinition } from "@/features/properties";

import type { ControlledQueryDraft } from "../../query/hooks";
import { isCollectionFilterDraftValid } from "../model/query";
import type {
  CollectionFilterRule,
  CollectionPresentationDescriptor,
  CollectionQueryState,
} from "../model/types";

export function hasCollectionSort<Item>(
  property: CollectionPropertyDefinition<Item>,
): boolean {
  return Boolean(
    property.capabilities?.sort &&
    (property.capabilities.sort.kind === "custom" ||
      property.semantics.kind === "standard"),
  );
}

export function propertyByKey<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
  propertyKey: string,
): CollectionPropertyDefinition<Item> | undefined {
  return descriptor.properties.find((property) => property.key === propertyKey);
}

export function propertyLabel<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
  propertyKey: string,
): string {
  return propertyByKey(descriptor, propertyKey)?.label ?? propertyKey;
}

export function isFilterDraftValid<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
  value: CollectionQueryState,
  draft: ControlledQueryDraft<CollectionFilterRule> | null,
): boolean {
  return isCollectionFilterDraftValid(descriptor, value, draft);
}

export function CollectionPropertyChoiceList<Item>({
  properties,
  icon,
  onSelect,
}: {
  properties: readonly CollectionPropertyDefinition<Item>[];
  icon: LucideIcon;
  onSelect(property: CollectionPropertyDefinition<Item>): void;
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
