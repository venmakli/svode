import { useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronRight,
  Circle,
  Flag,
  Hash,
  Link,
  ListTree,
  Mail,
  Phone,
  Save,
  Search,
  SortAsc,
  SortDesc,
  Tag,
  Type,
  User,
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/shared/lib/utils";
import type {
  ActorCandidate,
  CollectionSchema,
  PropertyOption,
  PropertyType,
} from "@/features/properties";
import { PropertyBadge } from "@/features/properties/display";
import {
  actorDisplayName,
  initialsForActor,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import {
  filterOpsForField,
  FILTER_OP_LABELS,
  isMultiValueOp,
  needsFilterValue,
  queryField,
} from "../model/query-utils";
import { useSaveViewQuery } from "../hooks/use-save-view-query";
import type {
  FilterOp,
  QueryField,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "../model/types";

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
    <div className="max-h-64 overflow-y-auto">
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
    </div>
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
    <div className="max-h-64 overflow-y-auto">
      <div className="flex flex-col p-1">
        {fields.map((field) => (
          <PaneRow
            key={field.name}
            icon={propertyTypeIcon(field.type)}
            label={field.label}
            meta={fieldTypeLabel(field.type)}
            onClick={() => onSelect(field)}
          />
        ))}
      </div>
    </div>
  );
}

export function FilterEditor({
  schema,
  draft,
  actors,
  onRequestActors,
  onChange,
}: {
  schema: Parameters<typeof queryField>[0];
  draft: QueryFilter;
  actors: ActorCandidate[];
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  onChange: (filter: QueryFilter) => void;
}) {
  const field = queryField(schema, draft.field, "filter");
  const ops = field ? filterOpsForField(field) : [];
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
          actors={actors}
          onRequestActors={onRequestActors}
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
  actors,
  onRequestActors,
  onChange,
}: {
  field: QueryField;
  filter: QueryFilter;
  actors: ActorCandidate[];
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
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
  if (field.type === "actor") {
    return (
      <ActorChecklist
        actors={actors}
        values={filterValues(filter).map(String)}
        onRequestActors={onRequestActors}
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
  if (field.type === "unique_id") {
    return (
      <UniqueIdFilterInput field={field} filter={filter} onChange={onChange} />
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

function UniqueIdFilterInput({
  field,
  filter,
  onChange,
}: {
  field: QueryField;
  filter: QueryFilter;
  onChange: (filter: QueryFilter) => void;
}) {
  const multiple = isMultiValueOp(filter.op);
  const values = filterValues(filter).map(String);
  const value = multiple
    ? values.join(", ")
    : typeof filter.value === "number" || typeof filter.value === "string"
      ? String(filter.value)
      : "";
  const placeholder = field.column?.prefix?.trim()
    ? `${field.column.prefix.trim()}-24`
    : "24";

  return (
    <Input
      type="text"
      inputMode="text"
      value={value}
      placeholder={multiple ? `${placeholder}, ${placeholder}` : placeholder}
      onChange={(event) => {
        const next = event.target.value;
        if (multiple) {
          onChange(
            filterWithValues(
              filter,
              next
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            ),
          );
        } else {
          onChange({ ...filter, value: next, values: undefined });
        }
      }}
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

function ActorChecklist({
  actors,
  values,
  onRequestActors,
  onChange,
}: {
  actors: ActorCandidate[];
  values: string[];
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  onChange: (values: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = new Set(values);
  const visible = actors.filter((actor) => {
    const needle = search.trim().toLowerCase();
    return (
      !needle ||
      actor.email.toLowerCase().includes(needle) ||
      actorDisplayName(actor).toLowerCase().includes(needle)
    );
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-7"
          value={search}
          placeholder={m.view_query_search_actors()}
          onFocus={() => void onRequestActors?.()}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="flex max-h-44 flex-col overflow-auto">
        {visible.map((actor) => (
          <label
            key={actor.email}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
          >
            <Checkbox
              checked={selected.has(actor.email)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(actor.email);
                else next.delete(actor.email);
                onChange([...next]);
              }}
            />
            <Avatar className="size-6">
              <AvatarFallback>{initialsForActor(actor)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 truncate">{actorDisplayName(actor)}</span>
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
  onSaved?: (schema: CollectionSchema) => void;
}) {
  const saveViewQuery = useSaveViewQuery({ query, onSaved });

  if (!query.hasLocalChanges) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      className="w-full justify-start"
      disabled={query.issues.length > 0}
      onClick={() => void saveViewQuery()}
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
        "flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        active && "bg-muted",
      )}
      onClick={onClick}
    >
      <Icon />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {warning ? <AlertTriangle className="text-warning" /> : null}
      {meta ? (
        <span className="max-w-28 shrink-0 truncate text-[11.5px] text-muted-foreground">
          {meta}
        </span>
      ) : null}
      <ChevronRight className="text-muted-foreground" />
    </button>
  );
}

export function EmptyPane({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <Icon className="size-5" />
      <span>{label}</span>
    </div>
  );
}

function fieldTypeLabel(type: PropertyType) {
  const labels: Record<PropertyType, string> = {
    text: String(m.table_property_type_text()),
    number: String(m.table_property_type_number()),
    select: String(m.table_property_type_select()),
    multi_select: String(m.table_property_type_multi_select()),
    status: String(m.table_property_type_status()),
    date: String(m.table_property_type_date()),
    unique_id: String(m.table_property_type_unique_id()),
    actor: String(m.table_property_type_actor()),
    checkbox: String(m.table_property_type_checkbox()),
    url: String(m.table_property_type_url()),
    email: String(m.table_property_type_email()),
    phone: String(m.table_property_type_phone()),
    relation: String(m.table_property_type_relation()),
  };
  return labels[type];
}

function propertyTypeIcon(type: PropertyType) {
  const icons: Record<PropertyType, LucideIcon> = {
    text: Type,
    number: Hash,
    select: Circle,
    multi_select: Tag,
    status: Flag,
    date: Calendar,
    unique_id: Hash,
    actor: User,
    checkbox: Check,
    url: Link,
    email: Mail,
    phone: Phone,
    relation: ListTree,
  };
  return icons[type];
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
