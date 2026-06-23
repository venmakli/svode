import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowUpDown,
  Calendar,
  Eye,
  EyeOff,
  FileText,
  Filter,
  LayoutGrid,
  Plus,
  Settings,
  SmilePlus,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type {
  UseViewQueryResult,
  ViewType,
} from "@/features/collection/query/model";
import type { CollectionSchema, PropertyType } from "@/features/properties";
import { handleError } from "../../hooks/error-feedback";
import { TypePane } from "../table/column-menu-panes";
import { SortableFieldVisibilityRow } from "../view-settings-panes";
import { SettingsRow, SettingsSection } from "../settings-row";
import * as m from "@/paraglide/messages.js";

export function ViewSettingsPropertiesPane({
  type,
  schema,
  savedFields,
  systemFieldIds,
  customFieldIds,
  reorderFields,
  addColumn,
  openProperty,
  toggleField,
}: {
  type: ViewType;
  schema: CollectionSchema;
  savedFields: string[];
  systemFieldIds: string[];
  customFieldIds: string[];
  reorderFields: (event: DragEndEvent, groupIds: string[]) => void;
  addColumn: () => void;
  openProperty: (field: string) => void;
  toggleField: (field: string, locked?: boolean) => void;
}) {
  const propertySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const systemFields = [
    {
      name: "title",
      label: schema.systemFields?.title?.label || m.collection_field_title(),
      icon: FileText,
      locked: type !== "gallery",
    },
    { name: "icon", label: m.collection_field_icon(), icon: SmilePlus },
    {
      name: "description",
      label: m.collection_field_description(),
      icon: FileText,
    },
    { name: "created", label: m.collection_field_created(), icon: Calendar },
    { name: "updated", label: m.collection_field_updated(), icon: Calendar },
  ];

  return (
    <div className="flex flex-col p-1">
      <SettingsSection label={m.collection_system_fields()} />
      <DndContext
        sensors={propertySensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => reorderFields(event, systemFieldIds)}
      >
        <SortableContext
          items={systemFieldIds}
          strategy={verticalListSortingStrategy}
        >
          {systemFields.map((field) => (
            <SortableFieldVisibilityRow
              key={field.name}
              id={field.name}
              icon={field.icon}
              label={field.label}
              visible={savedFields.includes(field.name)}
              locked={field.locked}
              onClick={() => openProperty(field.name)}
              onToggle={() => toggleField(field.name, field.locked)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <SettingsSection label={m.collection_custom_fields()} />
      {schema.columns.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          {m.collection_no_properties()}
        </div>
      ) : (
        <DndContext
          sensors={propertySensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => reorderFields(event, customFieldIds)}
        >
          <SortableContext
            items={customFieldIds}
            strategy={verticalListSortingStrategy}
          >
            {schema.columns.map((column) => (
              <SortableFieldVisibilityRow
                key={column.name}
                id={column.name}
                icon={Settings}
                label={column.name}
                meta={column.type}
                visible={savedFields.includes(column.name)}
                onClick={() => openProperty(column.name)}
                onToggle={() => toggleField(column.name)}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}
      <Separator className="my-1" />
      <SettingsRow
        icon={Plus}
        label={m.collection_add_property()}
        right={null}
        onClick={addColumn}
      />
    </div>
  );
}

export function ViewSettingsPropertyAddTypePane({
  addColumnWithType,
}: {
  addColumnWithType: (propertyType: PropertyType) => Promise<void>;
}) {
  return (
    <TypePane
      activeType="text"
      onSelect={(nextType) =>
        void addColumnWithType(nextType).catch(handleError)
      }
    />
  );
}

export function ViewSettingsPropertyEditPane({
  selectedProperty,
  savedFields,
  schema,
  query,
  toggleField,
  openFieldFilter,
  openFieldSort,
}: {
  selectedProperty: string;
  savedFields: string[];
  schema: CollectionSchema;
  query: UseViewQueryResult;
  toggleField: (field: string, locked?: boolean) => void;
  openFieldFilter: (field: string) => void;
  openFieldSort: (field: string) => void;
}) {
  return (
    <div className="flex flex-col p-1">
      <SettingsSection label={m.collection_properties_label()} />
      {selectedProperty === "title" ? (
        <SettingsRow
          icon={FileText}
          label={m.collection_field_title()}
          meta={schema.systemFields?.title?.label ?? m.collection_field_title()}
          onClick={() => undefined}
        />
      ) : (
        <SettingsRow
          icon={LayoutGrid}
          label={m.table_column_type()}
          meta={
            schema.columns.find((column) => column.name === selectedProperty)
              ?.type ?? "-"
          }
          onClick={() => undefined}
        />
      )}
      <SettingsRow
        icon={savedFields.includes(selectedProperty) ? Eye : EyeOff}
        label={m.table_visible()}
        meta={
          savedFields.includes(selectedProperty)
            ? m.view_query_yes()
            : m.view_query_no()
        }
        onClick={() =>
          selectedProperty !== "title" && toggleField(selectedProperty)
        }
      />
      <SettingsSection label={m.table_query_section()} />
      <SettingsRow
        icon={Filter}
        label={m.table_filter()}
        meta={
          query.merged.filter.find(
            (filter) => filter.field === selectedProperty,
          )?.op ?? m.collection_none()
        }
        onClick={() => openFieldFilter(selectedProperty)}
      />
      <SettingsRow
        icon={ArrowUpDown}
        label={m.view_query_sort_title()}
        meta={
          query.merged.sort.find((sort) => sort.field === selectedProperty)
            ? m.collection_rules_count({ count: 1 })
            : m.collection_none()
        }
        onClick={() => openFieldSort(selectedProperty)}
      />
    </div>
  );
}
