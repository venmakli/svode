import { useState } from "react";
import { AlertTriangle, ArrowUpDown, Filter, Settings2 } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  MultiPanePopover,
  PaneRow,
  QueryList,
  SortEditor,
} from "@/features/collection/query/ui";
import type { ActorCandidate } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { useControlledQueryEditor } from "../../query/hooks";
import { SearchControl } from "../../ui/search-control";
import {
  createDefaultSystemCollectionFilterRule,
  systemCollectionFilterOperators,
} from "../model/query";
import { readSystemCollectionPresentationRuntime } from "../model/runtime";
import type {
  SystemCollectionFieldDescriptor,
  SystemCollectionFilterRule,
  SystemCollectionPresentationRuntime,
  SystemCollectionQueryState,
  SystemCollectionSortDescriptor,
} from "../model/types";
import { SystemCollectionQueryFilterEditor } from "./query-filter-editor";
import {
  fieldByKey,
  fieldLabel,
  hasSystemCollectionSort,
  isFilterDraftValid,
  QueryAddButton,
  QueryEditorFooter,
  SystemCollectionFieldChoiceList,
} from "./query-editor-parts";

type SystemCollectionQueryPane =
  | "main"
  | "filter"
  | "filterField"
  | "filterEditor"
  | "sort"
  | "sortField"
  | "sortEditor";

export interface SystemCollectionQueryEditorProps {
  actors?: ActorCandidate[];
  onChange(query: SystemCollectionQueryState): void;
  onDismissResetWarning?(): void;
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  presentation: SystemCollectionPresentationRuntime;
  resetWarning?: boolean;
  value: SystemCollectionQueryState;
}

export function SystemCollectionQueryEditor({
  actors = [],
  onChange,
  onDismissResetWarning,
  onRequestActors,
  presentation,
  resetWarning = false,
  value,
}: SystemCollectionQueryEditorProps) {
  const { descriptor } =
    readSystemCollectionPresentationRuntime(presentation).instance;
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<SystemCollectionQueryPane>("main");
  const [searchOpen, setSearchOpen] = useState(Boolean(value.search));
  const filterFields = descriptor.fields.filter(
    (field) => systemCollectionFilterOperators(field).length > 0,
  );
  const sortFields = descriptor.fields.filter(hasSystemCollectionSort);
  const editor = useControlledQueryEditor<
    SystemCollectionFieldDescriptor<unknown>,
    SystemCollectionFilterRule,
    SystemCollectionSortDescriptor
  >({
    fields: descriptor.fields.map((field) => ({
      ...field,
      createFilter:
        systemCollectionFilterOperators(field).length > 0
          ? () =>
              createDefaultSystemCollectionFilterRule(field) ??
              ({
                fieldKey: field.key,
                operator: "",
              } satisfies SystemCollectionFilterRule)
          : undefined,
      createSort: hasSystemCollectionSort(field)
        ? () => ({
            direction: "asc" as const,
            fieldKey: field.key,
          })
        : undefined,
    })),
    onChange: (change) =>
      onChange({
        ...value,
        ...(change.filters ? { filters: change.filters } : {}),
        ...(change.sort ? { sort: change.sort } : {}),
      }),
    value,
  });

  function setEditorPane(nextPane: SystemCollectionQueryPane) {
    if (nextPane !== "filterEditor") {
      editor.setFilterDraft(null);
    }
    if (nextPane !== "sortEditor") {
      editor.setSortDraft(null);
    }
    setPane(nextPane);
  }

  function startFilter(fieldKey?: string) {
    if (editor.startFilter(fieldKey)) {
      setPane("filterEditor");
    }
  }

  function startSort(fieldKey?: string) {
    if (editor.startSort(fieldKey)) {
      setPane("sortEditor");
    }
  }

  function closePopover(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setEditorPane("main");
    }
  }

  const filterDraft = editor.filterDraft;
  const sortDraft = editor.sortDraft;
  const filterDraftField = filterDraft
    ? fieldByKey(descriptor, filterDraft.item.fieldKey)
    : undefined;
  const filterDraftValid = isFilterDraftValid(descriptor, value, filterDraft);
  const settingsCount = value.filters.length + value.sort.length;
  const hasSettings =
    filterFields.length > 0 || sortFields.length > 0 || resetWarning;

  const panes = [
    {
      content: (
        <div className="flex flex-col p-1">
          {resetWarning ? (
            <Alert className="mb-1">
              <AlertTriangle />
              <AlertTitle>{m.system_collection_query_reset_title()}</AlertTitle>
              <AlertDescription>
                {m.system_collection_query_reset_description()}
              </AlertDescription>
              {onDismissResetWarning ? (
                <AlertAction>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={onDismissResetWarning}
                  >
                    {m.system_collection_query_reset_dismiss()}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          ) : null}
          {filterFields.length > 0 ? (
            <PaneRow
              icon={Filter}
              label={m.view_query_filter_title()}
              meta={
                value.filters.length > 0
                  ? String(value.filters.length)
                  : undefined
              }
              onClick={() => setEditorPane("filter")}
            />
          ) : null}
          {sortFields.length > 0 ? (
            <PaneRow
              icon={ArrowUpDown}
              label={m.view_query_sort_title()}
              meta={
                value.sort.length > 0 ? String(value.sort.length) : undefined
              }
              onClick={() => setEditorPane("sort")}
            />
          ) : null}
        </div>
      ),
      id: "main" as const,
      title: m.view_query_settings_title(),
    },
    {
      content: (
        <QueryList
          emptyIcon={Filter}
          emptyLabel={m.view_query_filter_empty()}
          rows={value.filters.map((rule, index) => ({
            icon: Filter,
            key: `${rule.fieldKey}-${index}`,
            label: fieldLabel(descriptor, rule.fieldKey),
            meta: rule.operator,
            onClick: () => {
              editor.editFilter({ ...rule }, index);
              setPane("filterEditor");
            },
          }))}
        />
      ),
      footer: (
        <QueryAddButton
          label={m.view_query_add_filter()}
          onClick={() => setEditorPane("filterField")}
        />
      ),
      id: "filter" as const,
      title: m.view_query_filter_title(),
    },
    {
      content: (
        <SystemCollectionFieldChoiceList
          fields={filterFields}
          icon={Filter}
          onSelect={(field) => startFilter(field.key)}
        />
      ),
      id: "filterField" as const,
      title: m.view_query_choose_property(),
    },
    {
      content:
        filterDraft && filterDraftField ? (
          <SystemCollectionQueryFilterEditor
            actors={actors}
            field={filterDraftField}
            onChange={(item) =>
              editor.setFilterDraft((current) =>
                current ? { ...current, item } : current,
              )
            }
            onRequestActors={onRequestActors}
            rule={filterDraft.item}
          />
        ) : null,
      footer: filterDraft ? (
        <QueryEditorFooter
          applyDisabled={!filterDraftValid}
          applyLabel={m.view_query_apply_filter()}
          deleteLabel={m.view_query_clear_filter()}
          onApply={() => {
            if (editor.applyFilterDraft()) {
              setEditorPane("filter");
            }
          }}
          onDelete={() => {
            editor.removeFilterDraft();
            setEditorPane("filter");
          }}
        />
      ) : null,
      id: "filterEditor" as const,
      title: filterDraft
        ? m.view_query_filter_editor_title({
            field: fieldLabel(descriptor, filterDraft.item.fieldKey),
          })
        : m.view_query_filter_title(),
    },
    {
      content: (
        <QueryList
          emptyIcon={ArrowUpDown}
          emptyLabel={m.view_query_sort_empty()}
          rows={value.sort.map((sort, index) => ({
            icon: ArrowUpDown,
            key: `${sort.fieldKey}-${index}`,
            label: fieldLabel(descriptor, sort.fieldKey),
            meta:
              sort.direction === "desc"
                ? m.view_query_sort_desc()
                : m.view_query_sort_asc(),
            onClick: () => {
              editor.editSort({ ...sort }, index);
              setPane("sortEditor");
            },
          }))}
        />
      ),
      footer: (
        <QueryAddButton
          label={m.view_query_add_sort()}
          onClick={() => setEditorPane("sortField")}
        />
      ),
      id: "sort" as const,
      title: m.view_query_sort_title(),
    },
    {
      content: (
        <SystemCollectionFieldChoiceList
          fields={sortFields}
          icon={ArrowUpDown}
          onSelect={(field) => startSort(field.key)}
        />
      ),
      id: "sortField" as const,
      title: m.view_query_choose_property(),
    },
    {
      content: sortDraft ? (
        <SortEditor
          sort={{
            desc: sortDraft.item.direction === "desc",
            field: sortDraft.item.fieldKey,
          }}
          onChange={(sort) =>
            editor.setSortDraft((current) =>
              current
                ? {
                    ...current,
                    item: {
                      direction: sort.desc ? "desc" : "asc",
                      fieldKey: sort.field,
                    },
                  }
                : current,
            )
          }
        />
      ) : null,
      footer: sortDraft ? (
        <QueryEditorFooter
          applyLabel={m.view_query_apply_sort()}
          deleteLabel={m.view_query_delete_sort()}
          onApply={() => {
            if (editor.applySortDraft()) {
              setEditorPane("sort");
            }
          }}
          onDelete={() => {
            editor.removeSortDraft();
            setEditorPane("sort");
          }}
        />
      ) : null,
      id: "sortEditor" as const,
      title: sortDraft
        ? m.view_query_sort_editor_title({
            field: fieldLabel(descriptor, sortDraft.item.fieldKey),
          })
        : m.view_query_sort_title(),
    },
  ];

  if (!descriptor.query.getSearchText && !hasSettings) {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      {descriptor.query.getSearchText ? (
        <SearchControl
          open={searchOpen}
          query={value.search}
          onOpenChange={setSearchOpen}
          onQueryChange={(search) => onChange({ ...value, search })}
        />
      ) : null}
      {hasSettings ? (
        <MultiPanePopover
          mainPane="main"
          open={open}
          pane={pane}
          panes={panes}
          trigger={
            <Button
              type="button"
              size={settingsCount > 0 ? "sm" : "icon-sm"}
              variant={
                settingsCount > 0 || resetWarning ? "secondary" : "ghost"
              }
              aria-label={m.view_query_settings_title()}
            >
              {resetWarning ? <AlertTriangle /> : <Settings2 />}
              {settingsCount > 0 ? <span>{settingsCount}</span> : null}
            </Button>
          }
          onOpenChange={closePopover}
          onPaneChange={setEditorPane}
        />
      ) : null}
    </div>
  );
}
