import { useState } from "react";

export interface ControlledQueryDraft<Item> {
  index: number | null;
  item: Item;
}

export interface ControlledQueryEditorField<Filter, Sort> {
  key: string;
  createFilter?: () => Filter;
  createSort?: () => Sort;
}

export interface ControlledQueryValue<Filter, Sort> {
  filters: readonly Filter[];
  sort: readonly Sort[];
}

export interface ControlledQueryChange<Filter, Sort> {
  filters?: readonly Filter[];
  sort?: readonly Sort[];
}

interface UseControlledQueryEditorOptions<Field, Filter, Sort> {
  fields: readonly (Field & ControlledQueryEditorField<Filter, Sort>)[];
  value: ControlledQueryValue<Filter, Sort>;
  onChange(change: ControlledQueryChange<Filter, Sort>): void;
}

export function resolveControlledQueryEditorField<Field, Filter, Sort>(
  fields: readonly (Field & ControlledQueryEditorField<Filter, Sort>)[],
  capability: "createFilter" | "createSort",
  fieldKey?: string,
): (Field & ControlledQueryEditorField<Filter, Sort>) | null {
  return (
    fields.find(
      (candidate) =>
        (fieldKey === undefined || candidate.key === fieldKey) &&
        Boolean(candidate[capability]),
    ) ?? null
  );
}

export function applyControlledQueryDraft<Item>(
  items: readonly Item[],
  draft: ControlledQueryDraft<Item>,
): readonly Item[] {
  if (
    draft.index !== null &&
    (draft.index < 0 || draft.index >= items.length)
  ) {
    return items;
  }
  const next = [...items];
  if (draft.index === null) {
    next.push(draft.item);
  } else {
    next[draft.index] = draft.item;
  }
  return next;
}

export function removeControlledQueryDraft<Item>(
  items: readonly Item[],
  draft: ControlledQueryDraft<Item>,
): readonly Item[] {
  if (draft.index === null || draft.index < 0 || draft.index >= items.length) {
    return items;
  }
  return items.filter((_, index) => index !== draft.index);
}

export function useControlledQueryEditor<Field, Filter, Sort>({
  fields,
  value,
  onChange,
}: UseControlledQueryEditorOptions<Field, Filter, Sort>) {
  const [filterDraft, setFilterDraft] =
    useState<ControlledQueryDraft<Filter> | null>(null);
  const [sortDraft, setSortDraft] = useState<ControlledQueryDraft<Sort> | null>(
    null,
  );

  function startFilter(fieldKey?: string): boolean {
    const field = resolveControlledQueryEditorField(
      fields,
      "createFilter",
      fieldKey,
    );
    if (!field?.createFilter) {
      return false;
    }
    setFilterDraft({ index: null, item: field.createFilter() });
    return true;
  }

  function editFilter(filter: Filter, index: number) {
    setFilterDraft({ index, item: filter });
  }

  function applyFilterDraft(): boolean {
    if (!filterDraft) {
      return false;
    }
    const filters = applyControlledQueryDraft(value.filters, filterDraft);
    if (filters === value.filters) {
      return false;
    }
    onChange({ filters });
    return true;
  }

  function removeFilterDraft(): boolean {
    if (!filterDraft) {
      return false;
    }
    const filters = removeControlledQueryDraft(value.filters, filterDraft);
    if (filters !== value.filters) {
      onChange({ filters });
    }
    return true;
  }

  function startSort(fieldKey?: string): boolean {
    const field = resolveControlledQueryEditorField(
      fields,
      "createSort",
      fieldKey,
    );
    if (!field?.createSort) {
      return false;
    }
    setSortDraft({ index: null, item: field.createSort() });
    return true;
  }

  function editSort(sort: Sort, index: number) {
    setSortDraft({ index, item: sort });
  }

  function applySortDraft(): boolean {
    if (!sortDraft) {
      return false;
    }
    const sort = applyControlledQueryDraft(value.sort, sortDraft);
    if (sort === value.sort) {
      return false;
    }
    onChange({ sort });
    return true;
  }

  function removeSortDraft(): boolean {
    if (!sortDraft) {
      return false;
    }
    const sort = removeControlledQueryDraft(value.sort, sortDraft);
    if (sort !== value.sort) {
      onChange({ sort });
    }
    return true;
  }

  return {
    applyFilterDraft,
    applySortDraft,
    editFilter,
    editSort,
    filterDraft,
    removeFilterDraft,
    removeSortDraft,
    setFilterDraft,
    setSortDraft,
    sortDraft,
    startFilter,
    startSort,
  };
}
