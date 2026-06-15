import { useState } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
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
import {
  defaultFilterOpForField,
  queryField,
  queryFields,
} from "@/features/collection/query";
import type {
  CollectionView,
  QueryField,
  QueryFilter,
  QuerySort,
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
import type {
  CollectionSchema,
  PropertyType,
} from "@/features/properties/model";
import { normalizeSchema } from "@/features/properties/lib";
import { useCollectionPersons } from "../hooks";
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
  const customFieldIds = schema.columns.map((column) => column.name);
  const [filterDraft, setFilterDraft] = useState<{
    index: number | null;
    filter: QueryFilter;
  } | null>(null);
  const [sortDraft, setSortDraft] = useState<{
    index: number | null;
    sort: QuerySort;
  } | null>(null);
  const [selectedProperty, setSelectedProperty] = useState("title");
  const { persons: queryPersons, loadPersons: loadQueryPersons } =
    useCollectionPersons(spacePath);

  function setPane(nextPane: SettingsPane) {
    if (nextPane !== "filterEditor") setFilterDraft(null);
    if (nextPane !== "sortEditor") setSortDraft(null);
    onPaneChange(nextPane);
  }

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
    setPane(nextPane);
    onOpenChange(true);
  }

  function addFilterRule() {
    setPane("filterField");
  }

  function openNewFilter(field?: QueryField) {
    const selected = field ?? queryFields(schema, "filter")[0];
    if (!selected) return;
    setFilterDraft({
      index: null,
      filter: { field: selected.name, op: defaultFilterOpForField(selected) },
    });
    setPane("filterEditor");
  }

  function openExistingFilter(filter: QueryFilter, index: number) {
    setFilterDraft({ index, filter: { ...filter } });
    setPane("filterEditor");
  }

  function applyFilterDraft() {
    if (!filterDraft) return;
    const next = [...query.merged.filter];
    if (filterDraft.index === null) next.push(filterDraft.filter);
    else next[filterDraft.index] = filterDraft.filter;
    query.setLocalQuery({ filter: next });
    setPane("filter");
  }

  function clearFilterDraft() {
    if (!filterDraft) return;
    if (filterDraft.index !== null) {
      query.setLocalQuery({
        filter: query.merged.filter.filter(
          (_, index) => index !== filterDraft.index,
        ),
      });
    }
    setPane("filter");
  }

  function addSortRule() {
    setPane("sortField");
  }

  function openNewSort(field?: QueryField) {
    const selected = field ?? queryFields(schema, "sort")[0];
    if (!selected) return;
    setSortDraft({ index: null, sort: { field: selected.name, desc: false } });
    setPane("sortEditor");
  }

  function openExistingSort(sort: QuerySort, index: number) {
    setSortDraft({ index, sort: { ...sort } });
    setPane("sortEditor");
  }

  function applySortDraft() {
    if (!sortDraft) return;
    const next = [...query.merged.sort];
    if (sortDraft.index === null) next.push(sortDraft.sort);
    else next[sortDraft.index] = sortDraft.sort;
    query.setLocalQuery({ sort: next });
    setPane("sort");
  }

  function clearSortDraft() {
    if (!sortDraft) return;
    if (sortDraft.index !== null) {
      query.setLocalQuery({
        sort: query.merged.sort.filter((_, index) => index !== sortDraft.index),
      });
    }
    setPane("sort");
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

  function addColumn() {
    setPane("propertyAddType");
  }

  async function addColumnWithType(type: PropertyType) {
    const column = { name: nextColumnName(), type };
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
    setSelectedProperty(column.name);
    setPane("propertyEdit");
  }

  function openProperty(field: string) {
    setSelectedProperty(field);
    setPane("propertyEdit");
  }

  function openFieldFilter(field: string) {
    const existingIndex = query.merged.filter.findIndex(
      (item) => item.field === field,
    );
    const existing =
      existingIndex >= 0 ? query.merged.filter[existingIndex] : null;
    const fieldInfo = queryField(schema, field, "filter");
    if (!existing && !fieldInfo) return;
    setFilterDraft({
      index: existingIndex >= 0 ? existingIndex : null,
      filter: existing
        ? { ...existing }
        : {
            field,
            op: fieldInfo ? defaultFilterOpForField(fieldInfo) : "contains",
          },
    });
    setPane("filterEditor");
  }

  function openFieldSort(field: string) {
    const existingIndex = query.merged.sort.findIndex(
      (item) => item.field === field,
    );
    const existing =
      existingIndex >= 0 ? query.merged.sort[existingIndex] : null;
    setSortDraft({
      index: existingIndex >= 0 ? existingIndex : null,
      sort: existing ? { ...existing } : { field, desc: false },
    });
    setPane("sortEditor");
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
          persons={queryPersons}
          onRequestPersons={loadQueryPersons}
          onChange={(filter) => setFilterDraft({ ...filterDraft, filter })}
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
          onChange={(sort) => setSortDraft({ ...sortDraft, sort })}
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
