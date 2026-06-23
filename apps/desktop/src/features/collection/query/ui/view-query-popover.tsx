import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  Check,
  Columns3Icon,
  Filter,
  GripVertical,
  Group,
  Plus,
  SortAsc,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  CollectionSchema,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import { MultiPanePopover } from "./multi-pane-popover";
import {
  FieldChoiceList,
  FilterEditor,
  EmptyPane,
  PaneRow,
  QueryList,
  SaveButton,
  SortEditor,
} from "./query-controls";
import {
  defaultFilterOpForField,
  FILTER_OP_LABELS,
  queryField,
  queryFields,
} from "../model/query-utils";
import type {
  QueryEditorActorSource,
  QueryField,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "../model/types";

type QueryPane =
  | "main"
  | "filter"
  | "filterField"
  | "filterEditor"
  | "sort"
  | "sortField"
  | "sortEditor"
  | "group"
  | "groupField"
  | "groupEditor";

interface ViewQueryPopoverProps extends QueryEditorActorSource {
  trigger: React.ReactNode;
  query: UseViewQueryResult;
  schema: Parameters<typeof queryFields>[0];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialPane?: QueryPane;
  onSaved?: (schema: CollectionSchema) => void;
}

interface FilterDraft {
  index: number | null;
  filter: QueryFilter;
}

interface SortDraft {
  index: number | null;
  sort: QuerySort;
}

export function ViewQueryPopover({
  trigger,
  query,
  schema,
  actors = [],
  onRequestActors,
  open,
  onOpenChange,
  initialPane = "main",
  onSaved,
}: ViewQueryPopoverProps) {
  const normalizedSchema = useMemo(() => normalizeSchema(schema), [schema]);
  const [pane, setPane] = useState<QueryPane>(initialPane);
  const [innerOpen, setInnerOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<FilterDraft | null>(null);
  const [sortDraft, setSortDraft] = useState<SortDraft | null>(null);
  const [groupDraft, setGroupDraft] = useState<string | null>(
    query.merged.groupBy,
  );
  const effectiveOpen = open ?? innerOpen;
  const setEffectiveOpen = useCallback(
    (nextOpen: boolean) => {
      setInnerOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  const activeFilters = query.ephemeral?.filter ?? query.persistent.filter;
  const activeSort = query.ephemeral?.sort ?? query.persistent.sort;
  const activeGroupBy =
    query.ephemeral &&
    Object.prototype.hasOwnProperty.call(query.ephemeral, "groupBy")
      ? (query.ephemeral.groupBy ?? null)
      : query.persistent.groupBy;

  function openNewFilter(field?: QueryField) {
    const selected = field ?? queryFields(normalizedSchema, "filter")[0];
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

  function applyFilter() {
    if (!filterDraft) return;
    const next = [...activeFilters];
    if (filterDraft.index === null) next.push(filterDraft.filter);
    else next[filterDraft.index] = filterDraft.filter;
    query.setLocalQuery({ filter: next });
    setPane("filter");
  }

  function clearFilter() {
    if (!filterDraft) return;
    if (filterDraft.index === null) {
      setPane("filter");
      return;
    }
    query.setLocalQuery({
      filter: activeFilters.filter((_, index) => index !== filterDraft.index),
    });
    setPane("filter");
  }

  function openNewSort(field?: QueryField) {
    const selected = field ?? queryFields(normalizedSchema, "sort")[0];
    if (!selected) return;
    setSortDraft({ index: null, sort: { field: selected.name, desc: false } });
    setPane("sortEditor");
  }

  function openExistingSort(sort: QuerySort, index: number) {
    setSortDraft({ index, sort: { ...sort } });
    setPane("sortEditor");
  }

  function applySort() {
    if (!sortDraft) return;
    const next = [...activeSort];
    if (sortDraft.index === null) next.push(sortDraft.sort);
    else next[sortDraft.index] = sortDraft.sort;
    query.setLocalQuery({ sort: next });
    setPane("sort");
  }

  function clearSort() {
    if (!sortDraft) return;
    if (sortDraft.index === null) {
      setPane("sort");
      return;
    }
    query.setLocalQuery({
      sort: activeSort.filter((_, index) => index !== sortDraft.index),
    });
    setPane("sort");
  }

  function applyGroup() {
    query.setLocalQuery({ groupBy: groupDraft });
    setPane("group");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === "Escape" && effectiveOpen) {
        event.preventDefault();
        if (pane === "main") setEffectiveOpen(false);
        else setPane("main");
        return;
      }

      if (event.key === "ArrowLeft" && effectiveOpen && pane !== "main") {
        event.preventDefault();
        setPane("main");
        return;
      }

      if (!effectiveOpen && event.key === "f") {
        event.preventDefault();
        setPane("filter");
        setEffectiveOpen(true);
        return;
      }

      if (!effectiveOpen && event.key === "s") {
        event.preventDefault();
        setPane("sort");
        setEffectiveOpen(true);
        return;
      }

      if (!effectiveOpen && event.key === "g") {
        event.preventDefault();
        setPane(query.persistent.type === "board" ? "group" : "main");
        setEffectiveOpen(true);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [effectiveOpen, pane, query.persistent.type, setEffectiveOpen]);

  const panes = [
    {
      id: "main" as const,
      title: m.view_query_settings_title(),
      content: (
        <div className="flex flex-col p-1">
          <PaneRow
            icon={Filter}
            label={m.view_query_filter_title()}
            meta={counterLabel(activeFilters.length)}
            active={pane === "filter"}
            warning={query.invalidFilters.length > 0}
            onClick={() => setPane("filter")}
          />
          <PaneRow
            icon={SortAsc}
            label={m.view_query_sort_title()}
            meta={counterLabel(activeSort.length)}
            active={pane === "sort"}
            warning={query.invalidSorts.length > 0}
            onClick={() => setPane("sort")}
          />
          {query.persistent.type === "board" ? (
            <PaneRow
              icon={Columns3Icon}
              label={m.view_query_group_title()}
              meta={activeGroupBy ?? m.view_query_group_off()}
              active={pane === "group"}
              warning={Boolean(query.invalidGroupBy)}
              onClick={() => setPane("group")}
            />
          ) : null}
        </div>
      ),
      notice: query.hasLocalChanges ? (
        <Notice sharedChanged={query.sharedChanged} />
      ) : null,
    },
    {
      id: "filter" as const,
      title: m.view_query_filter_title(),
      content: (
        <QueryList
          emptyIcon={Filter}
          emptyLabel={m.view_query_filter_empty()}
          rows={activeFilters.map((filter, index) => {
            const field = queryField(normalizedSchema, filter.field, "filter");
            return {
              key: `${filter.field}-${index}`,
              icon: Filter,
              label: field?.label ?? filter.field,
              meta: FILTER_OP_LABELS[filter.op],
              warning: query.invalidFilters.includes(filter),
              onClick: () => openExistingFilter(filter, index),
            };
          })}
        />
      ),
      footer: (
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          onClick={() => setPane("filterField")}
        >
          <Plus data-icon="inline-start" />
          {m.view_query_add_filter()}
        </Button>
      ),
      footerSeparator: false,
    },
    {
      id: "filterField" as const,
      title: m.view_query_choose_property(),
      content: (
        <FieldChoiceList
          fields={queryFields(normalizedSchema, "filter")}
          onSelect={(field) => openNewFilter(field)}
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
          schema={normalizedSchema}
          draft={filterDraft.filter}
          actors={actors}
          onRequestActors={onRequestActors}
          onChange={(filter) => setFilterDraft({ ...filterDraft, filter })}
        />
      ) : null,
      footer: filterDraft ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            className="w-full justify-start"
            onClick={applyFilter}
          >
            <Check data-icon="inline-start" />
            {m.view_query_apply_filter()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start"
            onClick={clearFilter}
          >
            <Trash2 data-icon="inline-start" />
            {m.view_query_clear_filter()}
          </Button>
          <SaveButton query={query} onSaved={onSaved} />
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
          rows={activeSort.map((sort, index) => {
            const field = queryField(normalizedSchema, sort.field, "sort");
            return {
              key: `${sort.field}-${index}`,
              icon: GripVertical,
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
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          onClick={() => setPane("sortField")}
        >
          <Plus data-icon="inline-start" />
          {m.view_query_add_sort()}
        </Button>
      ),
      footerSeparator: false,
    },
    {
      id: "sortField" as const,
      title: m.view_query_choose_property(),
      content: (
        <FieldChoiceList
          fields={queryFields(normalizedSchema, "sort")}
          onSelect={(field) => openNewSort(field)}
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
            onClick={applySort}
          >
            <Check data-icon="inline-start" />
            {m.view_query_apply_sort()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full justify-start"
            onClick={clearSort}
          >
            <Trash2 data-icon="inline-start" />
            {m.view_query_delete_sort()}
          </Button>
          <SaveButton query={query} onSaved={onSaved} />
        </div>
      ) : null,
    },
    {
      id: "group" as const,
      title: m.view_query_group_title(),
      content: activeGroupBy ? (
        <div className="flex flex-col p-1">
          <PaneRow
            icon={Group}
            label={activeGroupBy}
            meta={m.view_query_group_by_field()}
            warning={Boolean(query.invalidGroupBy)}
            onClick={() => {
              setGroupDraft(activeGroupBy);
              setPane("groupEditor");
            }}
          />
        </div>
      ) : (
        <EmptyPane icon={Columns3Icon} label={m.view_query_group_empty()} />
      ),
      footer: (
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start"
          disabled={query.persistent.type !== "board"}
          onClick={() => setPane("groupField")}
        >
          <Plus data-icon="inline-start" />
          {m.view_query_add_group()}
        </Button>
      ),
      notice: m.view_query_group_notice(),
    },
    {
      id: "groupField" as const,
      title: m.view_query_choose_property(),
      content: (
        <FieldChoiceList
          fields={queryFields(normalizedSchema, "group")}
          onSelect={(field) => {
            setGroupDraft(field.name);
            setPane("groupEditor");
          }}
        />
      ),
    },
    {
      id: "groupEditor" as const,
      title: groupDraft
        ? m.view_query_group_editor_title({ field: groupDraft })
        : m.view_query_group_title(),
      content: (
        <div className="p-3 text-sm text-muted-foreground">
          {m.view_query_group_editor_description()}
        </div>
      ),
      footer: (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            className="w-full justify-start"
            onClick={applyGroup}
          >
            <Check data-icon="inline-start" />
            {m.view_query_apply_group()}
          </Button>
          <SaveButton query={query} onSaved={onSaved} />
        </div>
      ),
    },
  ];

  return (
    <MultiPanePopover
      trigger={trigger}
      panes={panes}
      mainPane="main"
      pane={pane}
      initialPane={initialPane}
      open={effectiveOpen}
      onOpenChange={setEffectiveOpen}
      onPaneChange={setPane}
    />
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" || tagName === "textarea" || target.isContentEditable
  );
}

function Notice({ sharedChanged }: { sharedChanged: boolean }) {
  return sharedChanged ? (
    <div>{m.view_query_shared_changed_notice()}</div>
  ) : (
    <div>{m.view_query_local_notice()}</div>
  );
}

function counterLabel(count: number) {
  return count > 0 ? String(count) : "";
}
