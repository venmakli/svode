import { ArrowUpDown, Check, Filter, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  queryField,
  queryFields,
  type QueryFilter,
  type QuerySort,
  type UseViewQueryResult,
} from "@/features/collection/query/model";
import {
  FieldChoiceList,
  FilterEditor,
  QueryList,
  SaveButton,
  SortEditor,
} from "@/features/collection/query/ui";
import type { ActorCandidate, CollectionSchema } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { QueryAddButton } from "../query-settings-pane";
import { GroupPane } from "../view-settings-panes";
import * as m from "@/paraglide/messages.js";

export function ViewSettingsFilterPane({
  schema,
  query,
  addFilterRule,
  openExistingFilter,
}: {
  schema: CollectionSchema;
  query: UseViewQueryResult;
  addFilterRule: () => void;
  openExistingFilter: (filter: QueryFilter, index: number) => void;
}) {
  return {
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
  };
}

export function ViewSettingsFilterFieldPane({
  schema,
  openNewFilter,
}: {
  schema: CollectionSchema;
  openNewFilter: Parameters<typeof FieldChoiceList>[0]["onSelect"];
}) {
  return (
    <FieldChoiceList
      fields={queryFields(schema, "filter")}
      onSelect={openNewFilter}
    />
  );
}

export function ViewSettingsFilterEditorPane({
  schema,
  query,
  filterDraft,
  queryActors,
  loadQueryActors,
  updateFilterDraft,
  applyFilterDraft,
  clearFilterDraft,
  onSchemaChange,
}: {
  schema: CollectionSchema;
  query: UseViewQueryResult;
  filterDraft: { index: number | null; filter: QueryFilter } | null;
  queryActors: ActorCandidate[];
  loadQueryActors: (allTime?: boolean) => Promise<ActorCandidate[]>;
  updateFilterDraft: (filter: QueryFilter) => void;
  applyFilterDraft: () => void;
  clearFilterDraft: () => void;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  if (!filterDraft) return { content: null, footer: null };

  return {
    content: (
      <FilterEditor
        schema={schema}
        draft={filterDraft.filter}
        actors={queryActors}
        onRequestActors={loadQueryActors}
        onChange={updateFilterDraft}
      />
    ),
    footer: (
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
          onSaved={(nextSchema) => onSchemaChange(normalizeSchema(nextSchema))}
        />
      </div>
    ),
  };
}

export function ViewSettingsSortPane({
  schema,
  query,
  addSortRule,
  openExistingSort,
}: {
  schema: CollectionSchema;
  query: UseViewQueryResult;
  addSortRule: () => void;
  openExistingSort: (sort: QuerySort, index: number) => void;
}) {
  return {
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
  };
}

export function ViewSettingsSortFieldPane({
  schema,
  openNewSort,
}: {
  schema: CollectionSchema;
  openNewSort: Parameters<typeof FieldChoiceList>[0]["onSelect"];
}) {
  return (
    <FieldChoiceList
      fields={queryFields(schema, "sort")}
      onSelect={openNewSort}
    />
  );
}

export function ViewSettingsSortEditorPane({
  query,
  sortDraft,
  updateSortDraft,
  applySortDraft,
  clearSortDraft,
  onSchemaChange,
}: {
  query: UseViewQueryResult;
  sortDraft: { index: number | null; sort: QuerySort } | null;
  updateSortDraft: (sort: QuerySort) => void;
  applySortDraft: () => void;
  clearSortDraft: () => void;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  if (!sortDraft) return { content: null, footer: null };

  return {
    content: <SortEditor sort={sortDraft.sort} onChange={updateSortDraft} />,
    footer: (
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
          onSaved={(nextSchema) => onSchemaChange(normalizeSchema(nextSchema))}
        />
      </div>
    ),
  };
}

export function ViewSettingsGroupPane({
  schema,
  query,
  onSchemaChange,
}: {
  schema: CollectionSchema;
  query: UseViewQueryResult;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  return {
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
  };
}
