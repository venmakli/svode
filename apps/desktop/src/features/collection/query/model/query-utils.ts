import type {
  CollectionSchema,
  PropertyType,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import type {
  CollectionView,
  FilterOp,
  QueryField,
  QueryFilter,
  QuerySort,
  QueryValidationIssue,
  QueryValidationResult,
  StoredViewQueryState,
  ViewQueryConfig,
  ViewQueryPatch,
  ViewType,
} from "./types";

const SYSTEM_FILTER_FIELDS: QueryField[] = [
  { name: "title", label: "Title", type: "text", kind: "system" },
  { name: "description", label: "Description", type: "text", kind: "system" },
  { name: "created", label: "Created", type: "date", kind: "system" },
  { name: "updated", label: "Updated", type: "date", kind: "system" },
];

const SYSTEM_SORT_FIELDS: QueryField[] = [
  { name: "title", label: "Title", type: "text", kind: "system" },
  { name: "created", label: "Created", type: "date", kind: "system" },
  { name: "updated", label: "Updated", type: "date", kind: "system" },
];

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  gt: "greater than",
  lt: "less than",
  gte: "greater or equal",
  lte: "less or equal",
  before: "before",
  after: "after",
  in: "one of",
  not_in: "not one of",
  contains_any: "contains any",
  not_contains_any: "does not contain any",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  group_eq: "group equals",
  group_neq: "group does not equal",
  group_in: "group is one of",
  group_not_in: "group is not one of",
};

const FILTER_OPS_BY_TYPE: Record<PropertyType, FilterOp[]> = {
  text: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  url: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  email: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  phone: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  number: ["eq", "neq", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"],
  date: ["eq", "neq", "before", "after", "is_empty", "is_not_empty"],
  unique_id: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  checkbox: ["eq", "neq"],
  select: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  multi_select: [
    "contains",
    "not_contains",
    "contains_any",
    "not_contains_any",
    "is_empty",
    "is_not_empty",
  ],
  status: [
    "eq",
    "neq",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
    "group_eq",
    "group_neq",
    "group_in",
    "group_not_in",
  ],
  actor: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  relation: [
    "contains",
    "not_contains",
    "contains_any",
    "not_contains_any",
    "is_empty",
    "is_not_empty",
  ],
};

export function viewStateStorageKey(collectionPath: string, viewName: string) {
  return `view-state-${collectionPath}-${viewName}`;
}

export function normalizeCollectionView(
  view: CollectionView | null | undefined,
): ViewQueryConfig {
  return {
    name: view?.name ?? "",
    type: view?.type ?? "table",
    filter: Array.isArray(view?.filter) ? view.filter : [],
    sort: Array.isArray(view?.sort) ? view.sort : [],
    groupBy: view?.groupBy ?? view?.group_by ?? null,
  };
}

export function queryFields(
  schema: CollectionSchema,
  context: "filter" | "sort" | "group",
) {
  const normalized = normalizeSchema(schema);
  const customFields: QueryField[] = normalized.columns.map((column) => ({
    name: column.name,
    label: column.name,
    type: column.type,
    kind: "custom",
    column,
  }));

  if (context === "filter") {
    return [...SYSTEM_FILTER_FIELDS, ...customFields];
  }
  if (context === "sort") {
    return [
      ...SYSTEM_SORT_FIELDS,
      ...customFields.filter((field) => field.type !== "multi_select"),
    ];
  }
  return customFields.filter(
    (field) =>
      field.type === "select" ||
      field.type === "status" ||
      (field.type === "actor" && !field.column?.multiple),
  );
}

export function queryField(
  schema: CollectionSchema,
  fieldName: string,
  context: "filter" | "sort" | "group",
) {
  return (
    queryFields(schema, context).find((field) => field.name === fieldName) ??
    null
  );
}

export function filterOpsForType(type: PropertyType) {
  return FILTER_OPS_BY_TYPE[type] ?? [];
}

export function filterOpsForField(field: QueryField) {
  if (field.type === "actor" && field.column?.multiple) {
    return [
      "contains",
      "not_contains",
      "contains_any",
      "not_contains_any",
      "is_empty",
      "is_not_empty",
    ] satisfies FilterOp[];
  }
  return filterOpsForType(field.type);
}

export function defaultFilterOp(type: PropertyType): FilterOp {
  if (
    type === "text" ||
    type === "url" ||
    type === "email" ||
    type === "phone"
  ) {
    return "contains";
  }
  if (type === "multi_select") return "contains";
  return "eq";
}

export function defaultFilterOpForField(field: QueryField): FilterOp {
  if (field.type === "actor" && field.column?.multiple) return "contains";
  return defaultFilterOp(field.type);
}

export function needsFilterValue(op: FilterOp) {
  return op !== "is_empty" && op !== "is_not_empty";
}

export function isMultiValueOp(op: FilterOp) {
  return (
    op === "in" ||
    op === "not_in" ||
    op === "contains_any" ||
    op === "not_contains_any" ||
    op === "group_in" ||
    op === "group_not_in"
  );
}

export function validateQuery(
  schema: CollectionSchema,
  viewType: ViewType,
  query: ViewQueryConfig,
): QueryValidationResult {
  const issues: QueryValidationIssue[] = [];
  const validFilters: QueryFilter[] = [];
  const invalidFilters: QueryFilter[] = [];
  const validSorts: QuerySort[] = [];
  const invalidSorts: QuerySort[] = [];

  for (const filter of query.filter) {
    const field = queryField(schema, filter.field, "filter");
    if (!field) {
      issues.push({ field: filter.field, reason: "unknown_field" });
      invalidFilters.push(filter);
      continue;
    }
    if (!filterOpsForField(field).includes(filter.op)) {
      issues.push({ field: filter.field, reason: "invalid_operator" });
      invalidFilters.push(filter);
      continue;
    }
    if (!isFilterValueValid(filter, field)) {
      issues.push({ field: filter.field, reason: "invalid_value" });
      invalidFilters.push(filter);
      continue;
    }
    validFilters.push(filter);
  }

  for (const sort of query.sort) {
    const field = queryField(schema, sort.field, "sort");
    if (!field) {
      issues.push({ field: sort.field, reason: "unknown_field" });
      invalidSorts.push(sort);
      continue;
    }
    validSorts.push(sort);
  }

  let groupBy = query.groupBy;
  let invalidGroupBy: string | null = null;
  if (groupBy) {
    const field = queryField(schema, groupBy, "group");
    if (viewType !== "board") {
      issues.push({ field: groupBy, reason: "invalid_view_type" });
      invalidGroupBy = groupBy;
      groupBy = null;
    } else if (!field) {
      issues.push({ field: groupBy, reason: "unknown_field" });
      invalidGroupBy = groupBy;
      groupBy = null;
    }
  }

  return {
    filter: validFilters,
    sort: validSorts,
    groupBy,
    invalidFilters,
    invalidSorts,
    invalidGroupBy,
    issues,
  };
}

function isFilterValueValid(filter: QueryFilter, field: QueryField) {
  if (!needsFilterValue(filter.op)) return true;
  const raw = filter.values ?? filter.value;
  if (raw === undefined || raw === null || raw === "") return false;
  if (field.type === "unique_id") {
    const values = Array.isArray(raw) ? raw : [raw];
    return (
      (!isMultiValueOp(filter.op) || Array.isArray(raw)) &&
      values.length > 0 &&
      values.every((value) => parseUniqueIdFilterValue(value, field))
    );
  }
  if (isMultiValueOp(filter.op)) return Array.isArray(raw) && raw.length > 0;
  if (field.type === "number") {
    return (
      typeof raw === "number" ||
      (typeof raw === "string" &&
        raw.trim() !== "" &&
        Number.isFinite(Number(raw)))
    );
  }
  if (field.type === "checkbox") return typeof raw === "boolean";
  if (
    field.type === "select" ||
    field.type === "multi_select" ||
    field.type === "status" ||
    field.type === "actor"
  ) {
    return typeof raw === "string" || (Array.isArray(raw) && raw.length > 0);
  }
  return true;
}

function parseUniqueIdFilterValue(value: unknown, field: QueryField) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0;
  }
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) > 0;
  const prefix = field.column?.prefix?.trim();
  if (!prefix) return false;
  const number = trimmed.startsWith(`${prefix}-`)
    ? trimmed.slice(prefix.length + 1)
    : "";
  return /^\d+$/.test(number) && Number(number) > 0;
}

export function resolveViewQuery(
  schema: CollectionSchema,
  view: CollectionView | null | undefined,
  ephemeral: StoredViewQueryState | null,
) {
  const persistent = normalizeCollectionView(view);
  const baseViewHash = viewQueryHash(schema, persistent);
  const localConfig = ephemeral
    ? {
        ...persistent,
        filter: ephemeral.filter ?? persistent.filter,
        sort: ephemeral.sort ?? persistent.sort,
        groupBy: Object.prototype.hasOwnProperty.call(ephemeral, "groupBy")
          ? (ephemeral.groupBy ?? null)
          : persistent.groupBy,
      }
    : persistent;
  const validation = validateQuery(schema, persistent.type, localConfig);
  const merged = {
    ...localConfig,
    filter: validation.filter,
    sort: validation.sort,
    groupBy: validation.groupBy,
  };
  return {
    persistent,
    merged,
    baseViewHash,
    sharedChanged: Boolean(
      ephemeral && ephemeral.baseViewHash !== baseViewHash,
    ),
    hasLocalChanges: Boolean(ephemeral && hasStoredQueryChanges(ephemeral)),
    invalidFilters: validation.invalidFilters,
    invalidSorts: validation.invalidSorts,
    invalidGroupBy: validation.invalidGroupBy,
    issues: validation.issues,
  };
}

export function viewQueryHash(schema: CollectionSchema, view: ViewQueryConfig) {
  const normalized = normalizeSchema(schema);
  return fnv1a(
    stableStringify({
      view: {
        name: view.name,
        type: view.type,
        filter: view.filter,
        sort: view.sort,
        groupBy: view.groupBy,
      },
      columns: normalized.columns.map((column) => ({
        name: column.name,
        type: column.type,
        multiple: column.multiple ?? null,
        prefix: column.prefix ?? null,
        options:
          column.options?.map((option) => ({
            name: option.name,
            group: option.group ?? null,
          })) ?? null,
      })),
    }),
  );
}

export function nextStoredQueryState(
  current: StoredViewQueryState | null,
  patch: ViewQueryPatch,
  baseViewHash: string,
) {
  return {
    ...(current ?? {}),
    ...patch,
    baseViewHash,
    updatedAt: new Date().toISOString(),
  } satisfies StoredViewQueryState;
}

export function viewUpdatePatch(query: ViewQueryConfig) {
  return {
    filter: query.filter,
    sort: query.sort,
    group_by: query.groupBy ?? null,
  };
}

function hasStoredQueryChanges(value: StoredViewQueryState) {
  return (
    Object.prototype.hasOwnProperty.call(value, "filter") ||
    Object.prototype.hasOwnProperty.call(value, "sort") ||
    Object.prototype.hasOwnProperty.call(value, "groupBy")
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
