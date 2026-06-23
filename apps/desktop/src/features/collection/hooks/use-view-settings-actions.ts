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
  const [filterDraft, setFilterDraft] = useState<{
    index: number | null;
    filter: QueryFilter;
  } | null>(null);
  const [sortDraft, setSortDraft] = useState<{
    index: number | null;
    sort: QuerySort;
  } | null>(null);
  const [selectedProperty, setSelectedProperty] = useState("title");

  const customFieldIds = schema.columns.map((column) => column.name);

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

  function updateFilterDraft(filter: QueryFilter) {
    if (!filterDraft) return;
    setFilterDraft({ ...filterDraft, filter });
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

  function updateSortDraft(sort: QuerySort) {
    if (!sortDraft) return;
    setSortDraft({ ...sortDraft, sort });
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
