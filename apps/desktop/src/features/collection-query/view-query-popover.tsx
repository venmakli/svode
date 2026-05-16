import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  ChevronRight,
  Columns3Icon,
  Filter,
  GripVertical,
  Group,
  Plus,
  Save,
  Search,
  SortAsc,
  SortDesc,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type {
  Person,
  PropertyOption,
  PropertyType,
} from "@/features/properties/types";
import { PropertyBadge } from "@/features/properties/property-badge";
import {
  initialsForPerson,
  normalizeSchema,
  personDisplayName,
} from "@/features/properties/utils";
import * as m from "@/paraglide/messages.js";
import { MultiPanePopover } from "./multi-pane-popover";
import {
  defaultFilterOp,
  filterOpsForType,
  FILTER_OP_LABELS,
  isMultiValueOp,
  needsFilterValue,
  queryField,
  queryFields,
} from "./query-utils";
import type {
  FilterOp,
  QueryEditorPersonSource,
  QueryField,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "./types";

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

interface ViewQueryPopoverProps extends QueryEditorPersonSource {
  trigger: React.ReactNode;
  query: UseViewQueryResult;
  schema: Parameters<typeof queryFields>[0];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialPane?: QueryPane;
  onSaved?: (schema: Parameters<typeof normalizeSchema>[0]) => void;
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
  persons = [],
  onRequestPersons,
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
  const setEffectiveOpen = (nextOpen: boolean) => {
    setInnerOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

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
      filter: { field: selected.name, op: defaultFilterOp(selected.type) },
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
  }, [effectiveOpen, pane, query.persistent.type]);

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
          persons={persons}
          onRequestPersons={onRequestPersons}
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
          <SaveButton query={query} />
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
          <SaveButton query={query} />
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

export function QueryList({
  rows,
  emptyIcon,
  emptyLabel,
}: {
  rows: Array<{
    key: string;
    icon: LucideIcon;
    label: string;
    meta: string;
    warning?: boolean;
    onClick: () => void;
  }>;
  emptyIcon: LucideIcon;
  emptyLabel: string;
}) {
  if (rows.length === 0)
    return <EmptyPane icon={emptyIcon} label={emptyLabel} />;
  return (
    <ScrollArea className="h-64">
      <div className="flex flex-col p-1">
        {rows.map((row) => (
          <PaneRow
            key={row.key}
            icon={row.icon}
            label={row.label}
            meta={row.meta}
            warning={row.warning}
            onClick={row.onClick}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

export function FieldChoiceList({
  fields,
  onSelect,
}: {
  fields: QueryField[];
  onSelect: (field: QueryField) => void;
}) {
  return (
    <ScrollArea className="h-64">
      <div className="flex flex-col p-1">
        {fields.map((field) => (
          <PaneRow
            key={field.name}
            icon={Filter}
            label={field.label}
            meta={fieldTypeLabel(field.type)}
            onClick={() => onSelect(field)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

export function FilterEditor({
  schema,
  draft,
  persons,
  onRequestPersons,
  onChange,
}: {
  schema: Parameters<typeof queryField>[0];
  draft: QueryFilter;
  persons: Person[];
  onRequestPersons?: (allTime?: boolean) => Promise<Person[]>;
  onChange: (filter: QueryFilter) => void;
}) {
  const field = queryField(schema, draft.field, "filter");
  const ops = field ? filterOpsForType(field.type) : [];
  return (
    <div className="flex flex-col gap-3 p-3">
      <Select
        value={draft.op}
        onValueChange={(op) => {
          const nextOp = op as FilterOp;
          onChange({
            field: draft.field,
            op: nextOp,
            value: needsFilterValue(nextOp) ? draft.value : undefined,
            values: needsFilterValue(nextOp) ? draft.values : undefined,
          });
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {ops.map((op) => (
              <SelectItem key={op} value={op}>
                {FILTER_OP_LABELS[op]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {field && needsFilterValue(draft.op) ? (
        <FilterValueControl
          field={field}
          filter={draft}
          persons={persons}
          onRequestPersons={onRequestPersons}
          onChange={onChange}
        />
      ) : (
        <div className="text-sm text-muted-foreground">
          {m.view_query_filter_no_value_needed()}
        </div>
      )}
    </div>
  );
}

function FilterValueControl({
  field,
  filter,
  persons,
  onRequestPersons,
  onChange,
}: {
  field: QueryField;
  filter: QueryFilter;
  persons: Person[];
  onRequestPersons?: (allTime?: boolean) => Promise<Person[]>;
  onChange: (filter: QueryFilter) => void;
}) {
  if (
    field.type === "select" ||
    field.type === "status" ||
    field.type === "multi_select"
  ) {
    const options =
      statusGroupOptions(field, filter.op) ?? field.column?.options ?? [];
    return (
      <OptionChecklist
        options={options}
        values={filterValues(filter)}
        onChange={(values) => onChange(filterWithValues(filter, values))}
      />
    );
  }
  if (field.type === "person") {
    return (
      <PersonChecklist
        persons={persons}
        values={filterValues(filter).map(String)}
        onRequestPersons={onRequestPersons}
        onChange={(values) => onChange(filterWithValues(filter, values))}
      />
    );
  }
  if (field.type === "checkbox") {
    return (
      <ToggleGroup
        type="single"
        value={
          filter.value === true ? "true" : filter.value === false ? "false" : ""
        }
        onValueChange={(value) =>
          onChange({ ...filter, value: value === "true" })
        }
      >
        <ToggleGroupItem value="true">{m.view_query_yes()}</ToggleGroupItem>
        <ToggleGroupItem value="false">{m.view_query_no()}</ToggleGroupItem>
      </ToggleGroup>
    );
  }
  if (field.type === "number") {
    return (
      <Input
        type="number"
        value={
          typeof filter.value === "number" || typeof filter.value === "string"
            ? filter.value
            : ""
        }
        onChange={(event) =>
          onChange({ ...filter, value: Number(event.target.value) })
        }
      />
    );
  }
  if (field.type === "date") {
    return (
      <Input
        type="date"
        value={typeof filter.value === "string" ? filter.value : ""}
        onChange={(event) => onChange({ ...filter, value: event.target.value })}
      />
    );
  }
  return (
    <Input
      value={typeof filter.value === "string" ? filter.value : ""}
      onChange={(event) => onChange({ ...filter, value: event.target.value })}
    />
  );
}

function OptionChecklist({
  options,
  values,
  onChange,
}: {
  options: PropertyOption[];
  values: unknown[];
  onChange: (values: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = new Set(values.map(String));
  const visible = options.filter((option) =>
    option.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-7"
          value={search}
          placeholder={m.view_query_search_options()}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="flex max-h-44 flex-col overflow-auto">
        {visible.map((option) => (
          <label
            key={option.name}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
          >
            <Checkbox
              checked={selected.has(option.name)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(option.name);
                else next.delete(option.name);
                onChange([...next]);
              }}
            />
            <PropertyBadge option={option} />
          </label>
        ))}
      </div>
    </div>
  );
}

function PersonChecklist({
  persons,
  values,
  onRequestPersons,
  onChange,
}: {
  persons: Person[];
  values: string[];
  onRequestPersons?: (allTime?: boolean) => Promise<Person[]>;
  onChange: (values: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = new Set(values);
  const visible = persons.filter((person) => {
    const needle = search.trim().toLowerCase();
    return (
      !needle ||
      person.email.toLowerCase().includes(needle) ||
      personDisplayName(person).toLowerCase().includes(needle)
    );
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-7"
          value={search}
          placeholder={m.view_query_search_people()}
          onFocus={() => void onRequestPersons?.()}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="flex max-h-44 flex-col overflow-auto">
        {visible.map((person) => (
          <label
            key={person.email}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
          >
            <Checkbox
              checked={selected.has(person.email)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(person.email);
                else next.delete(person.email);
                onChange([...next]);
              }}
            />
            <Avatar className="size-6">
              <AvatarFallback>{initialsForPerson(person)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 truncate">
              {personDisplayName(person)}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function SortEditor({
  sort,
  onChange,
}: {
  sort: QuerySort;
  onChange: (sort: QuerySort) => void;
}) {
  return (
    <div className="flex flex-col p-1">
      <PaneRow
        icon={SortAsc}
        label={m.view_query_sort_asc()}
        meta={!sort.desc ? "✓" : ""}
        onClick={() => onChange({ ...sort, desc: false })}
      />
      <PaneRow
        icon={SortDesc}
        label={m.view_query_sort_desc()}
        meta={sort.desc ? "✓" : ""}
        onClick={() => onChange({ ...sort, desc: true })}
      />
    </div>
  );
}

export function SaveButton({
  query,
  onSaved,
}: {
  query: UseViewQueryResult;
  onSaved?: (schema: Parameters<typeof normalizeSchema>[0]) => void;
}) {
  if (!query.hasLocalChanges) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      className="w-full justify-start"
      disabled={query.issues.length > 0}
      onClick={() => {
        void query
          .saveForAll({
            confirmOverwrite: () =>
              window.confirm(m.view_query_confirm_save_changed()),
          })
          .then((schema) => {
            if (schema) onSaved?.(schema);
          });
      }}
    >
      <Save data-icon="inline-start" />
      {m.view_query_save_for_all()}
    </Button>
  );
}

export function PaneRow({
  icon: Icon,
  label,
  meta,
  warning,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  warning?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        active && "bg-muted",
      )}
      onClick={onClick}
    >
      <Icon />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {warning ? <AlertTriangle className="text-warning" /> : null}
      {meta ? (
        <span className="max-w-28 truncate text-xs text-muted-foreground">
          {meta}
        </span>
      ) : null}
      <ChevronRight className="text-muted-foreground" />
    </button>
  );
}

function EmptyPane({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <Icon className="size-5" />
      <span>{label}</span>
    </div>
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

function fieldTypeLabel(type: PropertyType) {
  return type.replace("_", " ");
}

function filterValues(filter: QueryFilter) {
  if (Array.isArray(filter.values)) return filter.values;
  if (Array.isArray(filter.value)) return filter.value;
  if (
    filter.value === undefined ||
    filter.value === null ||
    filter.value === ""
  )
    return [];
  return [filter.value];
}

function filterWithValues(filter: QueryFilter, values: string[]): QueryFilter {
  if (isMultiValueOp(filter.op)) {
    return { ...filter, value: undefined, values };
  }
  return { ...filter, value: values[0] ?? "", values: undefined };
}

function statusGroupOptions(
  field: QueryField,
  op: FilterOp,
): PropertyOption[] | null {
  if (field.type !== "status" || !op.startsWith("group_")) return null;
  const groups = new Map<string, PropertyOption>();
  for (const option of field.column?.options ?? []) {
    if (option.group && !groups.has(option.group)) {
      groups.set(option.group, {
        name: option.group,
        color: option.color ?? null,
      });
    }
  }
  return [...groups.values()];
}
