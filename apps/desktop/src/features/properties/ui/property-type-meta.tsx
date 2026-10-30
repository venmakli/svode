import {
  AlertTriangle,
  BarChart3,
  Calendar,
  Check,
  Circle,
  Flag,
  Grid2X2,
  Hash,
  Info,
  KeyRound,
  Link,
  ListTree,
  Mail,
  Phone,
  Tag,
  Type,
  User,
  type LucideIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isPropertyTypeAddable, uniquePropertyName } from "../model/add-column";
import type { Column, PropertyType } from "../model/types";
import * as m from "@/paraglide/messages.js";

export const PROPERTY_TYPE_ICONS: Record<PropertyType, LucideIcon> = {
  text: Type,
  number: Hash,
  select: Circle,
  multi_select: Tag,
  status: Flag,
  date: Calendar,
  unique_id: Hash,
  actor: User,
  boolean: Check,
  url: Link,
  email: Mail,
  phone: Phone,
  relation: ListTree,
};

export function propertyTypeLabel(type: PropertyType) {
  const labels: Record<PropertyType, string> = {
    text: String(m.table_property_type_text()),
    number: String(m.table_property_type_number()),
    select: String(m.table_property_type_select()),
    multi_select: String(m.table_property_type_multi_select()),
    status: String(m.table_property_type_status()),
    date: String(m.table_property_type_date()),
    unique_id: String(m.table_property_type_unique_id()),
    actor: String(m.table_property_type_actor()),
    boolean: String(m.table_property_type_boolean()),
    url: String(m.table_property_type_url()),
    email: String(m.table_property_type_email()),
    phone: String(m.table_property_type_phone()),
    relation: String(m.table_property_type_relation()),
  };
  return labels[type];
}

export function propertyTypeAddUnavailableReason(
  columns: readonly Column[],
  type: PropertyType,
): string | null {
  return isPropertyTypeAddable(columns, type)
    ? null
    : m.property_type_add_unavailable({ type: propertyTypeLabel(type) });
}

/**
 * The column a UI entrypoint adds without asking for a name: named after its
 * type, numbered when taken; a relation points at the current collection.
 */
export function newPropertyColumn({
  columns,
  type,
  collectionPath,
}: {
  columns: readonly Column[];
  type: PropertyType;
  collectionPath: string | null | undefined;
}): Column {
  return {
    name: uniquePropertyName(columns, propertyTypeLabel(type)),
    type,
    ...(type === "relation" ? { relation: collectionPath || "." } : {}),
  };
}

export function propertyTypeSettingsMeta(column: Column): {
  icon: LucideIcon;
  label: string;
} | null {
  if (column.type === "select" || column.type === "multi_select") {
    return { icon: Grid2X2, label: m.table_type_settings_options() };
  }
  if (column.type === "status") {
    return { icon: Flag, label: m.table_type_settings_status() };
  }
  if (column.type === "date") {
    return { icon: Calendar, label: m.table_type_settings_date() };
  }
  if (column.type === "number") {
    return { icon: BarChart3, label: m.table_type_settings_number() };
  }
  if (column.type === "actor") {
    return { icon: User, label: m.table_type_settings_actor() };
  }
  if (column.type === "unique_id") {
    return { icon: KeyRound, label: m.table_type_settings_unique_id() };
  }
  if (column.type === "relation") {
    return { icon: ListTree, label: m.table_type_settings_relation() };
  }
  if (column.type === "boolean") {
    return { icon: Check, label: m.table_type_settings_boolean() };
  }
  return null;
}

export function SensitivePropertyTypeHint() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={m.property_pii_git_history_hint()}
          className="inline-flex text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          <AlertTriangle data-icon="inline-end" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" className="max-w-64">
        {m.property_pii_git_history_hint()}
      </TooltipContent>
    </Tooltip>
  );
}

/** Why a property type cannot be added, shown on hover of an info icon. */
export function PropertyTypeUnavailableHint({ reason }: { reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          data-property-type-unavailable-hint=""
          className="inline-flex text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          <Info data-icon="inline-end" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" className="max-w-64">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
