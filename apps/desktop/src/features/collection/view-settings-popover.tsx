import { invoke } from "@tauri-apps/api/core";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowUpDown,
  Calendar,
  Columns3,
  Copy,
  FileText,
  Filter,
  LayoutGrid,
  Plus,
  Settings,
  SmilePlus,
  Table,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { MultiPanePopover } from "@/features/collection-query/multi-pane-popover";
import {
  defaultFilterOp,
  queryFields,
} from "@/features/collection-query/query-utils";
import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "@/features/collection-query/types";
import type { CollectionSchema } from "@/features/properties/types";
import { handleError } from "./errors";
import { type SettingsPane, viewType } from "./utils";
import { QueryAddButton, QuerySettingsPane } from "./query-settings-pane";
import { SettingsRow, SettingsSection } from "./settings-row";
import {
  FieldVisibilityRow,
  GroupPane,
  SortableFieldVisibilityRow,
  TypeSettingsRows,
  ViewTypeRows,
  viewTypeLabel,
} from "./view-settings-panes";
import * as m from "@/paraglide/messages.js";

export function ViewSettingsPopover({
  open,
  pane,
  view,
  renameValue,
  onOpenChange,
  onPaneChange,
  onRenameValueChange,
  onRename,
  onUpdateView,
  onDuplicate,
  onDeleteRequest,
  schema,
  query,
  collectionPath,
  spacePath,
  projectPath,
  onSchemaChange,
  autoConfigForType,
}: {
  open: boolean;
  pane: SettingsPane;
  view: CollectionView | null;
  renameValue: string;
  onOpenChange: (open: boolean) => void;
  onPaneChange: (pane: SettingsPane) => void;
  onRenameValueChange: (value: string) => void;
  onRename: () => Promise<void>;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onDuplicate: () => Promise<void>;
  onDeleteRequest: () => void;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  autoConfigForType: (type: ViewType) => Record<string, unknown>;
}) {
  const type = viewType(view);
  const visibleFieldKey = type === "table" ? "visible_fields" : "card_fields";
  const savedFields = (view?.[visibleFieldKey] as string[] | undefined) ?? [
    "title",
    ...schema.columns.map((column) => column.name),
  ];
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
  const propertySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const systemFieldIds = systemFields.map((field) => field.name);
  const customFieldIds = schema.columns.map((column) => column.name);

  function toggleField(field: string, locked?: boolean) {
    if (!view || locked) return;
    const next = savedFields.includes(field)
      ? savedFields.filter((item) => item !== field)
      : [...savedFields, field];
    void onUpdateView(view.name, { [visibleFieldKey]: next }).catch(
      handleError,
    );
  }

  function reorderFields(event: DragEndEvent, groupIds: string[]) {
    if (!view || !event.over || event.active.id === event.over.id) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const oldIndex = groupIds.indexOf(activeId);
    const newIndex = groupIds.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;
    const groupOrder = arrayMove(groupIds, oldIndex, newIndex);
    const groupSet = new Set(groupIds);
    const outside = savedFields.filter((field) => !groupSet.has(field));
    const nextVisibleGroup = groupOrder.filter((field) =>
      savedFields.includes(field),
    );
    const next =
      groupIds === systemFieldIds
        ? [...nextVisibleGroup, ...outside]
        : [...outside, ...nextVisibleGroup];
    void onUpdateView(view.name, { [visibleFieldKey]: next }).catch(
      handleError,
    );
  }

  function updateTypeSetting(patch: Record<string, unknown>) {
    if (!view) return;
    void onUpdateView(view.name, patch).catch(handleError);
  }

  function openPane(nextPane: SettingsPane) {
    onPaneChange(nextPane);
    onOpenChange(true);
  }

  function addFilterRule() {
    const field = queryFields(schema, "filter")[0];
    if (!field) return;
    query.setLocalQuery({
      filter: [
        ...query.merged.filter,
        { field: field.name, op: defaultFilterOp(field.type) },
      ],
    });
  }

  function addSortRule() {
    const field = queryFields(schema, "sort")[0];
    if (!field) return;
    query.setLocalQuery({
      sort: [...query.merged.sort, { field: field.name, desc: false }],
    });
  }

  function nextColumnName() {
    const names = new Set(schema.columns.map((column) => column.name));
    let index = schema.columns.length + 1;
    let name = `Property ${index}`;
    while (names.has(name)) {
      index += 1;
      name = `Property ${index}`;
    }
    return name;
  }

  async function addColumn() {
    const column = { name: nextColumnName(), type: "text" };
    const next = await invoke<CollectionSchema>("add_schema_column", {
      space: spacePath,
      collectionPath,
      column,
      projectPath: projectPath ?? null,
    });
    onSchemaChange(next);
    if (view) {
      const nextFields = savedFields.includes(column.name)
        ? savedFields
        : [...savedFields, column.name];
      await onUpdateView(view.name, { [visibleFieldKey]: nextFields });
    }
  }

  const panes = [
    {
      id: "main" as const,
      title: view?.name ?? m.collection_view(),
      content: (
        <div className="flex flex-col p-1">
          <div className="p-2">
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => onRenameValueChange(event.target.value)}
              onBlur={() => void onRename().catch(handleError)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void onRename().catch(handleError);
              }}
              className="h-9 border-0 bg-muted px-3 text-sm font-semibold shadow-none focus-visible:ring-0"
            />
          </div>
          <SettingsSection label={m.collection_general_section()} />
          <SettingsRow
            icon={LayoutGrid}
            label={m.collection_view_type()}
            meta={viewTypeLabel(type)}
            onClick={() => openPane("layout")}
          />
          <SettingsRow
            icon={Table}
            label={m.collection_properties_label()}
            meta={m.collection_properties_shortcut()}
            onClick={() => openPane("properties")}
          />
          <SettingsRow
            icon={Filter}
            label={m.view_query_filter_title()}
            meta={queryCountLabel(query.merged.filter.length)}
            onClick={() => openPane("filter")}
          />
          <SettingsRow
            icon={ArrowUpDown}
            label={m.view_query_sort_title()}
            meta={queryCountLabel(query.merged.sort.length)}
            onClick={() => openPane("sort")}
          />
          {type === "board" ? (
            <SettingsRow
              icon={Columns3}
              label={m.view_query_group_title()}
              meta={String(
                (view?.group_by ??
                  view?.groupBy ??
                  m.collection_none()) as string,
              )}
              onClick={() => openPane("group")}
            />
          ) : null}
          <SettingsSection
            label={m.collection_view_specific_settings({ type })}
          />
          <TypeSettingsRows
            type={type}
            view={view}
            schema={schema}
            onPatch={updateTypeSetting}
          />
        </div>
      ),
      footer: (
        <div className="flex flex-col">
          <SettingsRow
            icon={Copy}
            label={m.collection_duplicate_view()}
            right={null}
            onClick={() => void onDuplicate().catch(handleError)}
          />
          <SettingsRow
            icon={Trash2}
            label={m.space_delete()}
            right={null}
            destructive
            onClick={onDeleteRequest}
          />
        </div>
      ),
    },
    {
      id: "layout" as const,
      title: m.collection_view_type(),
      content: (
        <ViewTypeRows
          type={type}
          onSelect={(nextType) =>
            view &&
            void onUpdateView(view.name, autoConfigForType(nextType)).catch(
              handleError,
            )
          }
        />
      ),
      notice: m.collection_view_type_notice(),
    },
    {
      id: "properties" as const,
      title: m.collection_properties_label(),
      content: (
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
                  onClick={() => toggleField(field.name, field.locked)}
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
                    onClick={() => toggleField(column.name)}
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
            onClick={() => void addColumn().catch(handleError)}
          />
        </div>
      ),
      notice: m.collection_properties_notice(),
    },
    {
      id: "filter" as const,
      title: m.view_query_filter_title(),
      content: (
        <QuerySettingsPane
          items={query.merged.filter}
          empty={m.collection_no_filters()}
          icon={Filter}
        />
      ),
      footer: (
        <QueryAddButton
          label={m.collection_add_filter()}
          onClick={addFilterRule}
        />
      ),
      footerSeparator: false,
    },
    {
      id: "sort" as const,
      title: m.view_query_sort_title(),
      content: (
        <QuerySettingsPane
          items={query.merged.sort}
          empty={m.collection_no_sorts()}
          icon={ArrowUpDown}
        />
      ),
      footer: (
        <QueryAddButton label={m.collection_add_sort()} onClick={addSortRule} />
      ),
      footerSeparator: false,
    },
    {
      id: "group" as const,
      title: m.view_query_group_title(),
      content: (
        <GroupPane view={view} schema={schema} onPatch={updateTypeSetting} />
      ),
    },
  ];

  return (
    <MultiPanePopover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onPaneChange("main");
        onOpenChange(nextOpen);
      }}
      pane={pane}
      onPaneChange={onPaneChange}
      mainPane="main"
      className="w-80 max-w-[calc(100vw-2rem)]"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            open && pane === "main" && "bg-accent text-accent-foreground",
          )}
        >
          <Settings />
          <span className="sr-only">{m.view_query_settings_title()}</span>
        </Button>
      }
      panes={panes}
    />
  );
}

function queryCountLabel(count: number) {
  return count > 0 ? m.collection_rules_count({ count }) : m.collection_none();
}
