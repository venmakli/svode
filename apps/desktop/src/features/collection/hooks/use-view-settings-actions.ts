import { useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { CollectionSchema, PropertyType } from "@/features/properties";
import { addCollectionColumn } from "../api";
import { handleError } from "./error-feedback";
import {
  defaultFilterOpForField,
  queryField,
  queryFields,
  type CollectionView,
  type QueryField,
  type QueryFilter,
  type QuerySort,
  type UseViewQueryResult,
} from "../query";
import { useControlledQueryEditor } from "../query/hooks";
import type { SettingsPane } from "../model";

export function useViewSettingsActions({
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
}: {
  view: CollectionView | null;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  savedFields: string[];
  visibleFieldKey: "visible_fields" | "card_fields";
  systemFieldIds: string[];
  onOpenChange: (open: boolean) => void;
  onPaneChange: (pane: SettingsPane) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  const [selectedProperty, setSelectedProperty] = useState("title");

  const customFieldIds = schema.columns.map((column) => column.name);
  const editorFields = new Map<
    string,
    {
      key: string;
      createFilter?: () => QueryFilter;
      createSort?: () => QuerySort;
    }
  >();
  for (const field of queryFields(schema, "filter")) {
    editorFields.set(field.name, {
      ...editorFields.get(field.name),
      key: field.name,
      createFilter: () => ({
        field: field.name,
        op: defaultFilterOpForField(field),
      }),
    });
  }
  for (const field of queryFields(schema, "sort")) {
    editorFields.set(field.name, {
      ...editorFields.get(field.name),
      key: field.name,
      createSort: () => ({ field: field.name, desc: false }),
    });
  }
  const controlledQuery = useControlledQueryEditor({
    fields: [...editorFields.values()],
    value: {
      filters: query.merged.filter,
      sort: query.merged.sort,
    },
    onChange: (change) =>
      query.setLocalQuery({
        ...(change.filters ? { filter: [...change.filters] } : {}),
        ...(change.sort ? { sort: [...change.sort] } : {}),
      }),
  });
  const filterDraft = controlledQuery.filterDraft
    ? {
        index: controlledQuery.filterDraft.index,
        filter: controlledQuery.filterDraft.item,
      }
    : null;
  const sortDraft = controlledQuery.sortDraft
    ? {
        index: controlledQuery.sortDraft.index,
        sort: controlledQuery.sortDraft.item,
      }
    : null;

  function setPane(nextPane: SettingsPane) {
    if (nextPane !== "filterEditor") controlledQuery.setFilterDraft(null);
    if (nextPane !== "sortEditor") controlledQuery.setSortDraft(null);
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
    if (!controlledQuery.startFilter(field?.name)) return;
    setPane("filterEditor");
  }

  function openExistingFilter(filter: QueryFilter, index: number) {
    controlledQuery.editFilter({ ...filter }, index);
    setPane("filterEditor");
  }

  function applyFilterDraft() {
    if (!controlledQuery.applyFilterDraft()) return;
    setPane("filter");
  }

  function clearFilterDraft() {
    if (!controlledQuery.filterDraft) return;
    controlledQuery.removeFilterDraft();
    setPane("filter");
  }

  function updateFilterDraft(filter: QueryFilter) {
    controlledQuery.setFilterDraft((current) =>
      current ? { ...current, item: filter } : current,
    );
  }

  function addSortRule() {
    setPane("sortField");
  }

  function openNewSort(field?: QueryField) {
    if (!controlledQuery.startSort(field?.name)) return;
    setPane("sortEditor");
  }

  function openExistingSort(sort: QuerySort, index: number) {
    controlledQuery.editSort({ ...sort }, index);
    setPane("sortEditor");
  }

  function applySortDraft() {
    if (!controlledQuery.applySortDraft()) return;
    setPane("sort");
  }

  function clearSortDraft() {
    if (!controlledQuery.sortDraft) return;
    controlledQuery.removeSortDraft();
    setPane("sort");
  }

  function updateSortDraft(sort: QuerySort) {
    controlledQuery.setSortDraft((current) =>
      current ? { ...current, item: sort } : current,
    );
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

  async function addColumnWithType(propertyType: PropertyType) {
    const column = { name: nextColumnName(), type: propertyType };
    const next = await addCollectionColumn({
      spacePath,
      collectionPath,
      column,
      projectPath,
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
    if (existing) {
      controlledQuery.editFilter({ ...existing }, existingIndex);
    } else if (!controlledQuery.startFilter(field)) {
      return;
    }
    setPane("filterEditor");
  }

  function openFieldSort(field: string) {
    const existingIndex = query.merged.sort.findIndex(
      (item) => item.field === field,
    );
    const existing =
      existingIndex >= 0 ? query.merged.sort[existingIndex] : null;
    if (existing) {
      controlledQuery.editSort({ ...existing }, existingIndex);
    } else if (!controlledQuery.startSort(field)) {
      return;
    }
    setPane("sortEditor");
  }

  return {
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
  };
}
