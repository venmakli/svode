import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpDown,
  BarChart3,
  Calendar,
  Check,
  Copy,
  EyeOff,
  Filter,
  Flag,
  Grid2X2,
  ListTree,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { FILTER_OP_LABELS } from "@/features/collection/query";
import type { QueryFilter, QuerySort } from "@/features/collection/query";
import type {
  CollectionSchema,
  Column,
  PropertyType,
} from "@/features/properties/model";
import { SettingsRow, SettingsSection } from "../settings-row";
import { PROPERTY_TYPE_ICONS } from "./icons";
import { propertyTypeLabel } from "./property-type-picker";
import { uniqueColumnName } from "./utils";
import * as m from "@/paraglide/messages.js";

export type ColumnMenuPane = "main" | "type" | "filter" | "sort" | "settings";

export function MainPane({
  field,
  label,
  column,
  collectionPath,
  spacePath,
  projectPath,
  isTitle,
  visibleFields,
  filter,
  sort,
  onLabelChange,
  onSchemaChange,
  onUpdateViewPatch,
  onOpenPane,
  onClose,
}: {
  field: string;
  label: string;
  column?: Column;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  isTitle: boolean;
  visibleFields: string[];
  filter: QueryFilter | null;
  sort: QuerySort | null;
  onLabelChange: (label: string) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateViewPatch: (patch: Record<string, unknown>) => Promise<void>;
  onOpenPane: (pane: ColumnMenuPane) => void;
  onClose: () => void;
}) {
  const typeSettings = column ? typeSettingsMeta(column) : null;

  return (
    <div className="flex flex-col p-1">
      <div className="p-1">
        <Input
          autoFocus
          value={label}
          className="h-9 border-0 bg-muted px-3 text-sm font-semibold shadow-none focus-visible:ring-0"
          onChange={(event) => onLabelChange(event.target.value)}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (!next) return;
            if (isTitle) {
              void invoke<CollectionSchema>("update_system_field_label", {
                space: spacePath,
                collectionPath,
                field: "title",
                label: next === m.collection_field_title() ? null : next,
                projectPath: projectPath ?? null,
              }).then(onSchemaChange);
            } else if (next !== field) {
              void invoke<CollectionSchema>("rename_schema_column", {
                space: spacePath,
                collectionPath,
                oldName: field,
                newName: next,
                projectPath: projectPath ?? null,
              })
                .then(onSchemaChange)
                .then(() =>
                  onUpdateViewPatch({
                    visible_fields: visibleFields.map((visible) =>
                      visible === field ? next : visible,
                    ),
                  }),
                );
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      {!isTitle && column ? (
        <>
          <SettingsSection label={m.collection_properties_label()} />
          <SettingsRow
            icon={Grid2X2}
            label={m.table_column_type()}
            meta={propertyTypeLabel(column.type)}
            onClick={() => onOpenPane("type")}
          />
          <SettingsRow
            icon={EyeOff}
            label={m.table_hide_column()}
            onClick={() => {
              void onUpdateViewPatch({
                visible_fields: visibleFields.filter(
                  (visible) => visible !== field,
                ),
              });
              onClose();
            }}
          />
          <ColumnMenuSeparator />
        </>
      ) : null}
      <SettingsSection label={m.table_query_section()} />
      <SettingsRow
        icon={Filter}
        label={m.table_filter()}
        meta={filter ? FILTER_OP_LABELS[filter.op] : m.collection_none()}
        onClick={() => onOpenPane("filter")}
      />
      <SettingsRow
        icon={ArrowUpDown}
        label={m.view_query_sort_title()}
        meta={sort ? sortDirectionLabel(sort) : m.collection_none()}
        onClick={() => onOpenPane("sort")}
      />
      {typeSettings ? (
        <>
          <ColumnMenuSeparator />
          <SettingsSection label={m.table_type_settings()} />
          <SettingsRow
            icon={typeSettings.icon}
            label={typeSettings.label}
            onClick={() => onOpenPane("settings")}
          />
        </>
      ) : null}
    </div>
  );
}

function ColumnMenuSeparator() {
  return <div className="mx-1 my-1 h-px bg-border/70" />;
}

export function TypePane({
  activeType,
  onSelect,
}: {
  activeType: PropertyType;
  onSelect: (type: PropertyType) => void;
}) {
  return (
    <div className="p-1">
      {Object.entries(PROPERTY_TYPE_ICONS).map(([type, Icon]) => (
        <SettingsRow
          key={type}
          icon={Icon}
          label={propertyTypeLabel(type as PropertyType)}
          right={type === activeType ? <Check data-icon="inline-end" /> : null}
          onClick={() => onSelect(type as PropertyType)}
        />
      ))}
    </div>
  );
}

export function ColumnDangerActions({
  column,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  onSchemaChange,
  onDelete,
}: {
  column: Column;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col">
      <SettingsRow
        icon={Copy}
        label={m.table_duplicate_column()}
        right={null}
        onClick={() => {
          const duplicate = {
            ...column,
            name: uniqueColumnName(
              schema,
              `${column.name} (${m.table_duplicate_column_suffix()})`,
            ),
          };
          void invoke<CollectionSchema>("add_schema_column", {
            space: spacePath,
            collectionPath,
            column: duplicate,
            projectPath: projectPath ?? null,
          }).then(onSchemaChange);
        }}
      />
      <SettingsRow
        icon={Trash2}
        label={m.table_delete_column()}
        right={null}
        destructive
        onClick={onDelete}
      />
    </div>
  );
}

function sortDirectionLabel(sort: QuerySort) {
  return sort.desc ? m.view_query_sort_desc() : m.view_query_sort_asc();
}

function hasTypeSettings(column: Column) {
  return [
    "select",
    "multi_select",
    "status",
    "date",
    "number",
    "person",
    "relation",
  ].includes(column.type);
}

function typeSettingsMeta(column: Column): {
  icon: LucideIcon;
  label: string;
} | null {
  if (!hasTypeSettings(column)) return null;

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
  if (column.type === "person") {
    return { icon: User, label: m.table_type_settings_person() };
  }
  if (column.type === "relation") {
    return { icon: ListTree, label: m.table_type_settings_relation() };
  }

  return null;
}
