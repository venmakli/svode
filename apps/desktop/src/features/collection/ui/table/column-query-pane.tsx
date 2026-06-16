import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  defaultFilterOpForField,
  queryField,
} from "@/features/collection/query";
import type {
  QueryEditorPersonSource,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query";
import {
  FilterEditor,
  SaveButton,
  SortEditor,
} from "@/features/collection/query";
import type { CollectionSchema } from "@/features/properties";
import { SettingsRow } from "../settings-row";
import * as m from "@/paraglide/messages.js";

export function FieldFilterPane({
  field,
  schema,
  query,
  persons = [],
  onRequestPersons,
  onSaved,
}: {
  field: string;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  onSaved?: (schema: CollectionSchema) => void;
} & QueryEditorPersonSource) {
  const info = useMemo(
    () => queryField(schema, field, "filter"),
    [field, schema],
  );
  const activeFilters = query.merged.filter;
  const existingIndex = activeFilters.findIndex((item) => item.field === field);
  const existingFilter =
    existingIndex >= 0 ? activeFilters[existingIndex] : null;
  const [draft, setDraft] = useState<QueryFilter | null>(
    existingFilter ? { ...existingFilter } : null,
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setDraft(existingFilter ? { ...existingFilter } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [existingFilter, field]);

  function addDraft() {
    if (!info) return;
    setDraft({ field, op: defaultFilterOpForField(info) });
  }

  function applyDraft() {
    if (!draft) return;
    const rest = activeFilters.filter((item) => item.field !== field);
    query.setLocalQuery({ filter: [...rest, draft] });
  }

  function clearDraft() {
    query.setLocalQuery({
      filter: activeFilters.filter((item) => item.field !== field),
    });
    setDraft(null);
  }

  if (!info) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        {m.view_query_unknown_field()}
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="flex flex-col p-1">
        <div className="px-2 py-6 text-center text-sm text-muted-foreground">
          {m.view_query_filter_empty()}
        </div>
        <SettingsRow
          icon={Plus}
          label={m.view_query_add_filter()}
          right={null}
          onClick={addDraft}
        />
        <SaveButton query={query} onSaved={onSaved} />
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <FilterEditor
        schema={schema}
        draft={draft}
        persons={persons}
        onRequestPersons={onRequestPersons}
        onChange={setDraft}
      />
      <div className="flex flex-col gap-1 border-t p-1">
        <Button type="button" onClick={applyDraft}>
          <Check data-icon="inline-start" />
          {m.view_query_apply_filter()}
        </Button>
        <Button type="button" variant="ghost" onClick={clearDraft}>
          <Trash2 data-icon="inline-start" />
          {m.view_query_clear_filter()}
        </Button>
        <SaveButton query={query} onSaved={onSaved} />
      </div>
    </div>
  );
}

export function FieldSortPane({
  field,
  query,
  onSaved,
}: {
  field: string;
  query: UseViewQueryResult;
  onSaved?: (schema: CollectionSchema) => void;
}) {
  const activeSort = query.merged.sort;
  const existingIndex = activeSort.findIndex((item) => item.field === field);
  const existingSort = existingIndex >= 0 ? activeSort[existingIndex] : null;
  const [draft, setDraft] = useState<QuerySort | null>(
    existingSort ? { ...existingSort } : null,
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setDraft(existingSort ? { ...existingSort } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [existingSort, field]);

  function applyDraft() {
    if (!draft) return;
    const rest = activeSort.filter((item) => item.field !== field);
    query.setLocalQuery({ sort: [...rest, draft] });
  }

  function clearDraft() {
    query.setLocalQuery({
      sort: activeSort.filter((item) => item.field !== field),
    });
    setDraft(null);
  }

  if (!draft) {
    return (
      <div className="flex flex-col p-1">
        <div className="px-2 py-6 text-center text-sm text-muted-foreground">
          {m.view_query_sort_empty()}
        </div>
        <SettingsRow
          icon={Plus}
          label={m.view_query_add_sort()}
          right={null}
          onClick={() => setDraft({ field, desc: false })}
        />
        <SaveButton query={query} onSaved={onSaved} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <SortEditor sort={draft} onChange={setDraft} />
      <div className="flex flex-col gap-1 border-t p-1">
        <Button type="button" onClick={applyDraft}>
          <Check data-icon="inline-start" />
          {m.view_query_apply_sort()}
        </Button>
        <Button type="button" variant="ghost" onClick={clearDraft}>
          <Trash2 data-icon="inline-start" />
          {m.view_query_delete_sort()}
        </Button>
        <SaveButton query={query} onSaved={onSaved} />
      </div>
    </div>
  );
}
