import { Check, Plus, Trash2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PaneRow } from "@/features/collection/query/ui";

import type { ControlledQueryDraft } from "../../query/hooks";
import { isSystemCollectionFilterDraftValid } from "../model/query";
import type {
  SystemCollectionFieldDescriptor,
  SystemCollectionFilterRule,
  SystemCollectionPresentationDescriptor,
  SystemCollectionQueryState,
} from "../model/types";

export function hasSystemCollectionSort<Row>(
  field: SystemCollectionFieldDescriptor<Row>,
): boolean {
  return Boolean(
    field.sort &&
    (field.sort.kind === "custom" || field.valueSemantics?.kind === "property"),
  );
}

export function fieldByKey<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  fieldKey: string,
): SystemCollectionFieldDescriptor<Row> | undefined {
  return descriptor.fields.find((field) => field.key === fieldKey);
}

export function fieldLabel<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  fieldKey: string,
): string {
  return fieldByKey(descriptor, fieldKey)?.label ?? fieldKey;
}

export function isFilterDraftValid<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  value: SystemCollectionQueryState,
  draft: ControlledQueryDraft<SystemCollectionFilterRule> | null,
): boolean {
  return isSystemCollectionFilterDraftValid(descriptor, value, draft);
}

export function SystemCollectionFieldChoiceList<Row>({
  fields,
  icon,
  onSelect,
}: {
  fields: readonly SystemCollectionFieldDescriptor<Row>[];
  icon: LucideIcon;
  onSelect(field: SystemCollectionFieldDescriptor<Row>): void;
}) {
  return (
    <div className="flex max-h-64 flex-col overflow-y-auto p-1">
      {fields.map((field) => (
        <PaneRow
          key={field.key}
          icon={icon}
          label={field.label}
          onClick={() => onSelect(field)}
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
