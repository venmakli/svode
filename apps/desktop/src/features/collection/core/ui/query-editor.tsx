import { useState } from "react";
import { AlertTriangle, ArrowUpDown, Filter } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { QueryList, SortEditor } from "@/features/collection/query/ui";
import type {
  ActorCandidate,
  CollectionPropertyDefinition,
} from "@/features/properties";
import { MultiPanePopover } from "@/shared/ui/multi-pane-popover";
import * as m from "@/paraglide/messages.js";

import { useControlledQueryEditor } from "../../query/hooks";
import { SearchControl } from "../../ui/search-control";
import { CollectionQueryToolbarButton } from "../../ui/presentation-core";
import {
  createDefaultCollectionCoreFilterRule,
  collectionCoreFilterOperators,
} from "../model/query";
import { readCollectionCorePresentationRuntime } from "../model/runtime";
import type {
  CollectionCoreFilterRule,
  CollectionCorePresentationRuntime,
  CollectionCoreQueryState,
  CollectionCoreSortDescriptor,
} from "../model/types";
import { CollectionCoreQueryFilterEditor } from "./query-filter-editor";
import {
  propertyByKey,
  propertyLabel,
  hasCollectionCoreSort,
  isFilterDraftValid,
  QueryAddButton,
  QueryEditorFooter,
  CollectionCorePropertyChoiceList,
} from "./query-editor-parts";

type CollectionCoreQueryPane =
  | "filter"
  | "filterField"
  | "filterEditor"
  | "sort"
  | "sortField"
  | "sortEditor";

export interface CollectionCoreQueryEditorProps {
  actors?: ActorCandidate[];
  onChange(query: CollectionCoreQueryState): void;
  onDismissResetWarning?(): void;
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  presentation: CollectionCorePresentationRuntime;
  resetWarning?: boolean;
  value: CollectionCoreQueryState;
}

export function CollectionCoreQueryEditor({
  actors = [],
  onChange,
  onDismissResetWarning,
  onRequestActors,
  presentation,
  resetWarning = false,
  value,
}: CollectionCoreQueryEditorProps) {
  const { descriptor } =
    readCollectionCorePresentationRuntime(presentation).instance;
  const [open, setOpen] = useState(false);
  const [rootPane, setRootPane] = useState<"filter" | "sort">("filter");
  const [pane, setPane] = useState<CollectionCoreQueryPane>("filter");
  const [searchOpen, setSearchOpen] = useState(Boolean(value.search));
  const filterFields = descriptor.properties.filter(
    (property) => collectionCoreFilterOperators(property).length > 0,
  );
  const sortFields = descriptor.properties.filter(hasCollectionCoreSort);
  const editor = useControlledQueryEditor<
    CollectionPropertyDefinition<unknown>,
    CollectionCoreFilterRule,
    CollectionCoreSortDescriptor
  >({
    fields: descriptor.properties.map((property) => ({
      ...property,
      createFilter:
        collectionCoreFilterOperators(property).length > 0
          ? () =>
              createDefaultCollectionCoreFilterRule(property) ??
              ({
                propertyKey: property.key,
                operator: "",
              } satisfies CollectionCoreFilterRule)
          : undefined,
      createSort: hasCollectionCoreSort(property)
        ? () => ({
            direction: "asc" as const,
            propertyKey: property.key,
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

  function setEditorPane(nextPane: CollectionCoreQueryPane) {
    if (nextPane !== "filterEditor") {
      editor.setFilterDraft(null);
    }
    if (nextPane !== "sortEditor") {
      editor.setSortDraft(null);
    }
    setPane(nextPane);
  }

  function startFilter(propertyKey?: string) {
    if (editor.startFilter(propertyKey)) {
      setPane("filterEditor");
    }
  }

  function startSort(propertyKey?: string) {
    if (editor.startSort(propertyKey)) {
      setPane("sortEditor");
    }
  }

  function closePopover(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setEditorPane(rootPane);
    }
  }

  function openRootPane(nextRootPane: "filter" | "sort") {
    setRootPane(nextRootPane);
    setEditorPane(nextRootPane);
    setOpen(true);
  }

  const filterDraft = editor.filterDraft;
  const sortDraft = editor.sortDraft;
  const filterDraftField = filterDraft
    ? propertyByKey(descriptor, filterDraft.item.propertyKey)
    : undefined;
  const filterDraftValid = isFilterDraftValid(descriptor, value, filterDraft);
  const hasQueryControls =
    filterFields.length > 0 || sortFields.length > 0 || resetWarning;
  const resetWarningNotice = resetWarning ? (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{m.collection_core_query_reset_title()}</AlertTitle>
      <AlertDescription>
        {m.collection_core_query_reset_description()}
      </AlertDescription>
      {onDismissResetWarning ? (
        <AlertAction>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onDismissResetWarning}
          >
            {m.collection_core_query_reset_dismiss()}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  ) : null;

  const panes = [
    {
      content: (
        <QueryList
          emptyIcon={Filter}
          emptyLabel={m.view_query_filter_empty()}
          rows={value.filters.map((rule, index) => ({
            icon: Filter,
            key: `${rule.propertyKey}-${index}`,
            label: propertyLabel(descriptor, rule.propertyKey),
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
      notice: resetWarningNotice,
      title: m.view_query_filter_title(),
    },
    {
      content: (
        <CollectionCorePropertyChoiceList
          properties={filterFields}
          icon={Filter}
          onSelect={(property) => startFilter(property.key)}
        />
      ),
      id: "filterField" as const,
      title: m.view_query_choose_property(),
    },
    {
      content:
        filterDraft && filterDraftField ? (
          <CollectionCoreQueryFilterEditor
            actors={actors}
            property={filterDraftField}
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
            field: propertyLabel(descriptor, filterDraft.item.propertyKey),
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
            key: `${sort.propertyKey}-${index}`,
            label: propertyLabel(descriptor, sort.propertyKey),
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
      notice: resetWarningNotice,
      title: m.view_query_sort_title(),
    },
    {
      content: (
        <CollectionCorePropertyChoiceList
          properties={sortFields}
          icon={ArrowUpDown}
          onSelect={(property) => startSort(property.key)}
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
            field: sortDraft.item.propertyKey,
          }}
          onChange={(sort) =>
            editor.setSortDraft((current) =>
              current
                ? {
                    ...current,
                    item: {
                      direction: sort.desc ? "desc" : "asc",
                      propertyKey: sort.field,
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
            field: propertyLabel(descriptor, sortDraft.item.propertyKey),
          })
        : m.view_query_sort_title(),
    },
  ];

  if (!descriptor.query.getSearchText && !hasQueryControls) {
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
      {hasQueryControls ? (
        <MultiPanePopover
          mainPane={rootPane}
          open={open}
          pane={pane}
          panes={panes}
          anchor={
            <div className="flex items-center gap-1">
              {filterFields.length > 0 ? (
                <CollectionQueryToolbarButton
                  active={open && rootPane === "filter"}
                  aria-expanded={open && rootPane === "filter"}
                  aria-haspopup="dialog"
                  count={value.filters.length}
                  icon={Filter}
                  label={m.view_query_filter_title()}
                  onClick={() => {
                    if (open && rootPane === "filter") {
                      setOpen(false);
                    } else {
                      openRootPane("filter");
                    }
                  }}
                />
              ) : null}
              {sortFields.length > 0 ? (
                <CollectionQueryToolbarButton
                  active={open && rootPane === "sort"}
                  aria-expanded={open && rootPane === "sort"}
                  aria-haspopup="dialog"
                  count={value.sort.length}
                  icon={ArrowUpDown}
                  label={m.view_query_sort_title()}
                  onClick={() => {
                    if (open && rootPane === "sort") {
                      setOpen(false);
                    } else {
                      openRootPane("sort");
                    }
                  }}
                />
              ) : null}
              {resetWarning &&
              filterFields.length === 0 &&
              sortFields.length === 0 ? (
                <CollectionQueryToolbarButton
                  active={open}
                  aria-expanded={open}
                  aria-haspopup="dialog"
                  icon={AlertTriangle}
                  label={m.collection_core_query_reset_title()}
                  onClick={() => {
                    if (open) setOpen(false);
                    else openRootPane("filter");
                  }}
                />
              ) : null}
            </div>
          }
          onOpenChange={closePopover}
          onPaneChange={setEditorPane}
        />
      ) : null}
    </div>
  );
}
