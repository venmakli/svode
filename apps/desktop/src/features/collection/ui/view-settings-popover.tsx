import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowUpDown,
  Calendar,
  Check,
  Columns3,
  Copy,
  Eye,
  EyeOff,
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
import { cn } from "@/shared/lib/utils";
import { MultiPanePopover } from "@/features/collection/query";
import { queryField, queryFields } from "@/features/collection/query";
import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "@/features/collection/query";
import {
  FieldChoiceList,
  FilterEditor,
  QueryList,
  SaveButton,
  SortEditor,
} from "@/features/collection/query";
import type { CollectionSchema } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { useCollectionActors, useViewSettingsActions } from "../hooks";
import { handleError } from "../lib/errors";
import { viewType } from "../lib/utils";
import type { SettingsPane } from "../model";
import { QueryAddButton } from "./query-settings-pane";
import { SettingsRow, SettingsSection } from "./settings-row";
import {
  GroupPane,
  SortableFieldVisibilityRow,
  TypeSettingsRows,
  ViewTypeRows,
  viewTypeLabel,
} from "./view-settings-panes";
import { TypePane } from "./table/column-menu-panes";
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
  const { actors: queryActors, loadActors: loadQueryActors } =
    useCollectionActors(spacePath);
  const {
    addColumn,
    addColumnWithType,
    addFilterRule,
    addSortRule,
    applyFilterDraft,
    applySortDraft,
    clearFilterDraft,
    clearSortDraft,
    customFieldIds,
    filterDraft,
    openExistingFilter,
    openExistingSort,
    openFieldFilter,
    openFieldSort,
    openNewFilter,
    openNewSort,
    openPane,
    openProperty,
    reorderFields,
    selectedProperty,
    setPane,
    sortDraft,
    toggleField,
    updateFilterDraft,
    updateSortDraft,
    updateTypeSetting,
  } = useViewSettingsActions({
    view,
    schema,
    query,
    collectionPath,
    spacePath,
    projectPath,
    savedFields,
    visibleFieldKey,
    systemFieldIds,
    onOpenChange,
    onPaneChange,
    onUpdateView,
    onSchemaChange,
  });

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
      ),
      notice: m.collection_properties_notice(),
    },
    {
      id: "propertyAddType" as const,
      title: m.table_property_type_title(),
      content: (
        <TypePane
          activeType="text"
          onSelect={(nextType) =>
            void addColumnWithType(nextType).catch(handleError)
          }
        />
      ),
      notice: m.table_property_type_notice(),
    },
    {
      id: "propertyEdit" as const,
      title: selectedProperty,
      content: (
        <div className="flex flex-col p-1">
          <SettingsSection label={m.collection_properties_label()} />
          {selectedProperty === "title" ? (
            <SettingsRow
              icon={FileText}
              label={m.collection_field_title()}
              meta={
                schema.systemFields?.title?.label ?? m.collection_field_title()
              }
              onClick={() => undefined}
            />
          ) : (
            <SettingsRow
              icon={LayoutGrid}
              label={m.table_column_type()}
              meta={
                schema.columns.find(
                  (column) => column.name === selectedProperty,
                )?.type ?? "-"
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
      ),
    },
    {
      id: "filter" as const,
      title: m.view_query_filter_title(),
      content: (
        <QueryList
          emptyIcon={Filter}
          emptyLabel={m.view_query_filter_empty()}
          rows={query.merged.filter.map((filter, index) => {
            const field = queryField(schema, filter.field, "filter");
            return {
              key: `${filter.field}-${index}`,
              icon: Filter,
              label: field?.label ?? filter.field,
              meta: filter.op,
              warning: query.invalidFilters.includes(filter),
              onClick: () => openExistingFilter(filter, index),
            };
          })}
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
      id: "filterField" as const,
      title: m.view_query_choose_property(),
      content: (
        <FieldChoiceList
          fields={queryFields(schema, "filter")}
          onSelect={openNewFilter}
        />
      ),
    },
    {
      id: "filterEditor" as const,
      title: filterDraft
        ? m.view_query_filter_editor_title({ field: filterDraft.filter.field })
        : m.view_query_filter_title(),
      content: filterDraft ? (
        <FilterEditor
          schema={schema}
          draft={filterDraft.filter}
          actors={queryActors}
          onRequestActors={loadQueryActors}
          onChange={updateFilterDraft}
        />
      ) : null,
      footer: filterDraft ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            className="w-full justify-start"
            onClick={applyFilterDraft}
          >
            <Check data-icon="inline-start" />
            {m.view_query_apply_filter()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start"
            onClick={clearFilterDraft}
          >
            <Trash2 data-icon="inline-start" />
            {m.view_query_clear_filter()}
          </Button>
          <SaveButton
            query={query}
            onSaved={(nextSchema) =>
              onSchemaChange(normalizeSchema(nextSchema))
            }
          />
        </div>
      ) : null,
    },
    {
      id: "sort" as const,
      title: m.view_query_sort_title(),
      content: (
        <QueryList
          emptyIcon={ArrowUpDown}
          emptyLabel={m.view_query_sort_empty()}
          rows={query.merged.sort.map((sort, index) => {
            const field = queryField(schema, sort.field, "sort");
            return {
              key: `${sort.field}-${index}`,
              icon: ArrowUpDown,
              label: field?.label ?? sort.field,
              meta: sort.desc
                ? m.view_query_sort_desc()
                : m.view_query_sort_asc(),
              warning: query.invalidSorts.includes(sort),
              onClick: () => openExistingSort(sort, index),
            };
          })}
        />
      ),
      footer: (
        <QueryAddButton label={m.collection_add_sort()} onClick={addSortRule} />
      ),
      footerSeparator: false,
    },
    {
      id: "sortField" as const,
      title: m.view_query_choose_property(),
      content: (
        <FieldChoiceList
          fields={queryFields(schema, "sort")}
          onSelect={openNewSort}
        />
      ),
    },
    {
      id: "sortEditor" as const,
      title: sortDraft
        ? m.view_query_sort_editor_title({ field: sortDraft.sort.field })
        : m.view_query_sort_title(),
      content: sortDraft ? (
        <SortEditor
          sort={sortDraft.sort}
          onChange={updateSortDraft}
        />
      ) : null,
      footer: sortDraft ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            className="w-full justify-start"
            onClick={applySortDraft}
          >
            <Check data-icon="inline-start" />
            {m.view_query_apply_sort()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start"
            onClick={clearSortDraft}
          >
            <Trash2 data-icon="inline-start" />
            {m.view_query_delete_sort()}
          </Button>
          <SaveButton
            query={query}
            onSaved={(nextSchema) =>
              onSchemaChange(normalizeSchema(nextSchema))
            }
          />
        </div>
      ) : null,
    },
    {
      id: "group" as const,
      title: m.view_query_group_title(),
      content: (
        <GroupPane
          schema={schema}
          activeGroupBy={query.merged.groupBy}
          onSelect={(field) => query.setLocalQuery({ groupBy: field })}
        />
      ),
      footer: (
        <SaveButton
          query={query}
          onSaved={(nextSchema) => onSchemaChange(normalizeSchema(nextSchema))}
        />
      ),
    },
  ];

  return (
    <MultiPanePopover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setPane("main");
        onOpenChange(nextOpen);
      }}
      pane={pane}
      onPaneChange={setPane}
      mainPane="main"
      className="w-80 max-w-[calc(100vw-2rem)]"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground",
            open &&
              pane === "main" &&
              "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
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
