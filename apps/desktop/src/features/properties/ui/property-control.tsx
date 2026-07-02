import { Checkbox } from "@/components/ui/checkbox";
import { ActorControl } from "./property-controls/actor-control";
import { DateControl } from "./property-controls/date-control";
import {
  EmailControl,
  PhoneControl,
  UrlControl,
} from "./property-controls/link-controls";
import {
  MultiSelectControl,
  SelectControl,
  StatusControl,
} from "./property-controls/option-controls";
import {
  NumberControl,
  TextControl,
} from "./property-controls/text-number-controls";
import { UniqueIdControl } from "./property-controls/unique-id-control";
import type { PropertyControlProps } from "./property-controls/types";
import { RelationControl } from "./relation-control";

export type { PropertyControlProps } from "./property-controls/types";

export function PropertyControl({
  column,
  value,
  invalid,
  disabled,
  autoOpen,
  actors = [],
  relationContext,
  relationPresentation,
  onRequestActors,
  onChange,
  onOpenChange,
}: PropertyControlProps) {
  switch (column.type) {
    case "number":
      return (
        <NumberControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "select":
      return (
        <SelectControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "multi_select":
      return (
        <MultiSelectControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "status":
      return (
        <StatusControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "date":
      return (
        <DateControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "unique_id":
      return (
        <UniqueIdControl column={column} value={value} invalid={invalid} />
      );
    case "actor":
      return (
        <ActorControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          actors={actors}
          onRequestActors={onRequestActors}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "relation":
      return (
        <RelationControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          context={relationContext}
          presentation={relationPresentation}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "checkbox":
      return (
        <Checkbox
          checked={Boolean(value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onCheckedChange={(checked) => {
            void onChange(checked === true);
          }}
        />
      );
    case "url":
      return (
        <UrlControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />
      );
    case "email":
      return (
        <EmailControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
        />
      );
    case "phone":
      return (
        <PhoneControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen={autoOpen}
          onChange={onChange}
        />
      );
    case "text":
    default:
      return (
        <TextControl
          value={value}
          invalid={invalid}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}
