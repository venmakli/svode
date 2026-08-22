import type { Column } from "@/features/properties";
import {
  effectiveBooleanValue,
  isDateRangeValue,
  isEmptyValue,
} from "@/features/properties";

import {
  defaultFilterOpForField,
  filterOpsForField,
} from "../../query/model/query-utils";
import type {
  FilterOp,
  QueryField,
  QueryFilter,
} from "../../query/model/types";
import type {
  SystemCollectionFieldDescriptor,
  SystemCollectionFilterRule,
  SystemCollectionPresentationDescriptor,
  SystemCollectionQueryState,
  SystemCollectionQueryValidationIssue,
  SystemCollectionQueryValidationResult,
  SystemCollectionSortDescriptor,
} from "./types";

export const EMPTY_SYSTEM_COLLECTION_QUERY: SystemCollectionQueryState =
  Object.freeze({
    filters: Object.freeze([]),
    search: "",
    sort: Object.freeze([]),
  });

export function normalizeSystemCollectionSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function systemCollectionFilterOperators<Row>(
  field: SystemCollectionFieldDescriptor<Row>,
): readonly string[] {
  if (!field.filter) {
    return [];
  }
  if (field.filter.kind === "custom") {
    return field.filter.operators;
  }
  const queryField = propertyQueryField(field);
  return queryField ? filterOpsForField(queryField) : [];
}

export function createDefaultSystemCollectionFilterRule<Row>(
  field: SystemCollectionFieldDescriptor<Row>,
): SystemCollectionFilterRule | null {
  const operators = systemCollectionFilterOperators(field);
  const operator =
    field.filter?.kind === "property"
      ? propertyQueryField(field)
        ? defaultFilterOpForField(propertyQueryField(field)!)
        : null
      : (operators[0] ?? null);
  return operator ? { fieldKey: field.key, operator } : null;
}

export function validateSystemCollectionQuery<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  query: SystemCollectionQueryState,
): SystemCollectionQueryValidationResult {
  const issues: SystemCollectionQueryValidationIssue[] = [];
  const filters: SystemCollectionFilterRule[] = [];
  const sort: SystemCollectionSortDescriptor[] = [];
  let search = query.search;

  if (!descriptor.query.getSearchText && query.search !== "") {
    search = "";
    issues.push({ reason: "search-unavailable" });
  }

  for (const rule of query.filters) {
    const field = descriptor.fields.find(
      (candidate) => candidate.key === rule.fieldKey,
    );
    if (!field) {
      issues.push({ fieldKey: rule.fieldKey, reason: "unknown-field" });
      continue;
    }
    if (!field.filter) {
      issues.push({ fieldKey: rule.fieldKey, reason: "unsupported-filter" });
      continue;
    }
    if (field.filter.kind === "property") {
      const queryField = propertyQueryField(field);
      if (!queryField) {
        issues.push({ fieldKey: rule.fieldKey, reason: "unsupported-filter" });
        continue;
      }
      const filter = propertyQueryFilter(rule);
      const reason = filterOpsForField(queryField).includes(filter.op)
        ? validateSystemCollectionPropertyFilterValue(filter, queryField)
        : "invalid_operator";
      if (reason) {
        issues.push({
          fieldKey: rule.fieldKey,
          operator: rule.operator,
          reason:
            reason === "invalid_operator"
              ? "invalid-operator"
              : "invalid-value",
        });
        continue;
      }
    } else {
      if (!field.filter.operators.includes(rule.operator)) {
        issues.push({
          fieldKey: rule.fieldKey,
          operator: rule.operator,
          reason: "invalid-operator",
        });
        continue;
      }
      const valid = safelyValidateCustomFilter(field.filter.validate, rule);
      if (!valid) {
        issues.push({
          fieldKey: rule.fieldKey,
          operator: rule.operator,
          reason: "invalid-value",
        });
        continue;
      }
    }
    filters.push(rule);
  }

  for (const item of query.sort) {
    const field = descriptor.fields.find(
      (candidate) => candidate.key === item.fieldKey,
    );
    if (!field) {
      issues.push({ fieldKey: item.fieldKey, reason: "unknown-field" });
      continue;
    }
    if (!field.sort) {
      issues.push({ fieldKey: item.fieldKey, reason: "unsupported-sort" });
      continue;
    }
    if (
      field.sort.kind === "property" &&
      field.valueSemantics?.kind !== "property"
    ) {
      issues.push({ fieldKey: item.fieldKey, reason: "unsupported-sort" });
      continue;
    }
    sort.push(item);
  }

  const reset = issues.length > 0;
  return {
    issues,
    query: reset ? { filters, search, sort } : query,
    reset,
  };
}

export function isSystemCollectionFilterDraftValid<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  query: SystemCollectionQueryState,
  draft: {
    index: number | null;
    item: SystemCollectionFilterRule;
  } | null,
): boolean {
  if (!draft) {
    return false;
  }
  if (
    draft.index !== null &&
    (draft.index < 0 || draft.index >= query.filters.length)
  ) {
    return false;
  }
  const filters = [...query.filters];
  if (draft.index === null) {
    filters.push(draft.item);
  } else {
    filters[draft.index] = draft.item;
  }
  const result = validateSystemCollectionQuery(descriptor, {
    ...query,
    filters,
  });
  return result.query.filters.includes(draft.item);
}

export function applySystemCollectionQuery<Row>({
  descriptor,
  query,
  rows,
}: {
  descriptor: SystemCollectionPresentationDescriptor<Row>;
  query: SystemCollectionQueryState;
  rows: readonly Row[];
}): {
  query: SystemCollectionQueryState;
  reset: boolean;
  rows: readonly Row[];
  sourceRows: readonly Row[];
} {
  const validation = validateSystemCollectionQuery(descriptor, query);
  const sourceRows = descriptor.query.fixedPredicate
    ? rows.filter(descriptor.query.fixedPredicate)
    : rows;
  const search = normalizeSystemCollectionSearchText(validation.query.search);
  let result = search
    ? sourceRows.filter((row) =>
        normalizeSystemCollectionSearchText(
          descriptor.query.getSearchText?.(row) ?? "",
        ).includes(search),
      )
    : [...sourceRows];

  for (const rule of validation.query.filters) {
    const field = descriptor.fields.find(
      (candidate) => candidate.key === rule.fieldKey,
    );
    if (!field?.filter) {
      continue;
    }
    const filter = field.filter;
    result = result.filter((row) =>
      filter.kind === "property"
        ? matchesPropertyFilter(field, row, rule)
        : filter.matches(row, rule),
    );
  }

  const ordering =
    validation.query.sort.length > 0
      ? validation.query.sort
      : descriptor.query.defaultSort;
  if (ordering && ordering.length > 0) {
    result.sort((left, right) =>
      compareRowsByFields(descriptor, ordering, left, right),
    );
  } else if (descriptor.query.defaultCompare) {
    result.sort((left, right) => {
      const compared = finiteComparison(
        descriptor.query.defaultCompare!(left, right),
      );
      return compared || compareRowIds(descriptor, left, right);
    });
  }

  return {
    query: validation.query,
    reset: validation.reset,
    rows: result,
    sourceRows,
  };
}

function validateSystemCollectionPropertyFilterValue(
  filter: QueryFilter,
  field: QueryField,
): "invalid_value" | null {
  const values = propertyFilterPayloadValues(filter);
  if (!values) {
    return "invalid_value";
  }
  if (filter.op === "is_empty" || filter.op === "is_not_empty") {
    return values.length === 0 ? null : "invalid_value";
  }
  const raw = values[0];
  if (
    field.type === "select" ||
    field.type === "multi_select" ||
    field.type === "relation"
  ) {
    return values.every(
      (value) =>
        typeof value === "string" &&
        field.column?.options?.some((option) => option.name === value),
    )
      ? null
      : "invalid_value";
  }
  if (field.type === "status") {
    if (filter.op.startsWith("group_")) {
      return values.every(
        (value) =>
          value === "todo" || value === "in_progress" || value === "done",
      )
        ? null
        : "invalid_value";
    }
    return values.every(
      (value) =>
        typeof value === "string" &&
        field.column?.options?.some((option) => option.name === value),
    )
      ? null
      : "invalid_value";
  }
  if (field.type === "actor") {
    return values.every((value) => typeof value === "string")
      ? null
      : "invalid_value";
  }
  if (field.type === "number") {
    return typeof raw === "number" && Number.isFinite(raw)
      ? null
      : "invalid_value";
  }
  if (field.type === "unique_id") {
    return values.every((value) =>
      isValidUniqueIdFilterValue(field.column, value),
    )
      ? null
      : "invalid_value";
  }
  if (field.type === "boolean") {
    return typeof raw === "boolean" ? null : "invalid_value";
  }
  if (field.type === "date") {
    return typeof raw === "string" &&
      (isIsoDateCell(raw) || isValidTodayMacro(raw))
      ? null
      : "invalid_value";
  }
  if (
    field.type === "text" ||
    field.type === "url" ||
    field.type === "email" ||
    field.type === "phone"
  ) {
    return typeof raw === "string" ? null : "invalid_value";
  }
  return null;
}

function isValidUniqueIdFilterValue(
  column: Column | undefined,
  value: unknown,
): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1;
  }
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  const prefix = column?.prefix?.trim();
  const numeric = prefix
    ? trimmed.startsWith(`${prefix}-`)
      ? trimmed.slice(prefix.length + 1)
      : ""
    : trimmed;
  if (!/^\d+$/.test(numeric)) {
    return false;
  }
  const parsed = BigInt(numeric);
  return parsed >= 1n && parsed <= 18_446_744_073_709_551_615n;
}

function isValidTodayMacro(value: string): boolean {
  if (value === "@today") {
    return true;
  }
  const match = value.match(/^@today[+-](?<offset>\d+)$/);
  if (!match?.groups?.offset) {
    return false;
  }
  return BigInt(match.groups.offset) <= 9_223_372_036_854_775_807n;
}

function propertyFilterPayloadValues(
  filter: QueryFilter,
): readonly unknown[] | null {
  if (filter.op === "is_empty" || filter.op === "is_not_empty") {
    return filter.value === undefined && filter.values === undefined
      ? []
      : null;
  }
  if (
    filter.op === "in" ||
    filter.op === "not_in" ||
    filter.op === "contains_any" ||
    filter.op === "not_contains_any" ||
    filter.op === "group_in" ||
    filter.op === "group_not_in"
  ) {
    const values =
      filter.values ??
      (Array.isArray(filter.value)
        ? filter.value
        : filter.value === undefined
          ? []
          : [filter.value]);
    return values.length > 0 ? values : null;
  }
  if (filter.values) {
    return filter.values.length === 1 ? filter.values : null;
  }
  if (filter.value === undefined || Array.isArray(filter.value)) {
    return null;
  }
  return [filter.value];
}

function isIsoDateCell(value: string): boolean {
  const match = value.match(
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d+)?)?)?$/,
  );
  if (!match?.groups) {
    return false;
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour ?? 0);
  const minute = Number(match.groups.minute ?? 0);
  const second = Number(match.groups.second ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function safelyValidateCustomFilter(
  validate: (rule: SystemCollectionFilterRule) => boolean,
  rule: SystemCollectionFilterRule,
): boolean {
  try {
    return validate(rule);
  } catch {
    return false;
  }
}

function propertyQueryField<Row>(
  field: SystemCollectionFieldDescriptor<Row>,
): QueryField | null {
  if (field.valueSemantics?.kind !== "property") {
    return null;
  }
  return {
    column: { ...field.valueSemantics.column, name: field.key },
    kind: "custom",
    label: field.label,
    name: field.key,
    type: field.valueSemantics.column.type,
  };
}

function propertyQueryFilter(rule: SystemCollectionFilterRule): QueryFilter {
  return {
    field: rule.fieldKey,
    op: rule.operator as FilterOp,
    value: rule.value,
    values: rule.values ? [...rule.values] : undefined,
  };
}

function matchesPropertyFilter<Row>(
  field: SystemCollectionFieldDescriptor<Row>,
  row: Row,
  rule: SystemCollectionFilterRule,
): boolean {
  if (field.valueSemantics?.kind !== "property") {
    return false;
  }
  const column = field.valueSemantics.column;
  const value = field.getValue(row);
  const values = rule.values ?? (rule.value === undefined ? [] : [rule.value]);
  const wanted = values[0];
  const empty = isEmptyValue(value);

  if (
    column.type === "boolean" &&
    (rule.operator === "eq" || rule.operator === "neq")
  ) {
    const effective = effectiveBooleanValue(value);
    const expected = effectiveBooleanValue(wanted);
    if (effective === undefined || expected === undefined) {
      return false;
    }
    return rule.operator === "eq"
      ? effective === expected
      : effective !== expected;
  }

  switch (rule.operator) {
    case "is_empty":
      return empty;
    case "is_not_empty":
      return !empty;
    case "eq":
      if (value === null || value === undefined) {
        return false;
      }
      if (column.type === "date") {
        return dateContains(value, resolveDateFilterValue(wanted));
      }
      return comparePropertyScalar(column, value, wanted) === 0;
    case "neq":
      if (empty) {
        return false;
      }
      if (column.type === "date") {
        return !dateContains(value, resolveDateFilterValue(wanted));
      }
      return comparePropertyScalar(column, value, wanted) !== 0;
    case "contains":
      if (value === null || value === undefined) {
        return false;
      }
      if (isMultiValueColumn(column)) {
        return propertyArray(value).some((item) => item === wanted);
      }
      return String(value ?? "")
        .toLowerCase()
        .includes(String(wanted ?? "").toLowerCase());
    case "not_contains":
      if (empty) {
        return false;
      }
      if (isMultiValueColumn(column)) {
        return !propertyArray(value).some((item) => item === wanted);
      }
      return !String(value)
        .toLowerCase()
        .includes(String(wanted ?? "").toLowerCase());
    case "in":
      if (value === null || value === undefined) {
        return false;
      }
      return values.some(
        (candidate) => comparePropertyScalar(column, value, candidate) === 0,
      );
    case "not_in":
      return (
        !empty &&
        !values.some(
          (candidate) => comparePropertyScalar(column, value, candidate) === 0,
        )
      );
    case "contains_any":
      return propertyArray(value).some((item) => values.includes(item));
    case "not_contains_any":
      return (
        !empty && !propertyArray(value).some((item) => values.includes(item))
      );
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (empty) {
        return false;
      }
      const compared = comparePropertyScalar(column, value, wanted);
      if (rule.operator === "gt") return compared > 0;
      if (rule.operator === "gte") return compared >= 0;
      if (rule.operator === "lt") return compared < 0;
      return compared <= 0;
    }
    case "before": {
      const target = resolveDateFilterValue(wanted);
      const end = dateBounds(value)?.end;
      return Boolean(end && target && end < target);
    }
    case "after": {
      const target = resolveDateFilterValue(wanted);
      const start = dateBounds(value)?.start;
      return Boolean(start && target && start > target);
    }
    case "group_eq":
    case "group_neq":
    case "group_in":
    case "group_not_in": {
      const option = column.options?.find(
        (candidate) => candidate.name === value,
      );
      const group = option?.group;
      const matches = values.includes(group);
      return rule.operator === "group_eq" || rule.operator === "group_in"
        ? matches
        : !empty && !matches;
    }
    default:
      return false;
  }
}

function compareRowsByFields<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  ordering: readonly SystemCollectionSortDescriptor[],
  left: Row,
  right: Row,
): number {
  for (const item of ordering) {
    const field = descriptor.fields.find(
      (candidate) => candidate.key === item.fieldKey,
    );
    if (!field?.sort) {
      continue;
    }
    const leftValue = field.getValue(left);
    const rightValue = field.getValue(right);
    const booleanProperty =
      field.sort.kind === "property" &&
      field.valueSemantics?.kind === "property" &&
      field.valueSemantics.column.type === "boolean";
    if (!booleanProperty) {
      const emptyOrder = compareEmptyValues(leftValue, rightValue);
      if (emptyOrder !== 0) {
        return emptyOrder;
      }
      if (isEmptyValue(leftValue)) {
        continue;
      }
    }
    const compared =
      field.sort.kind === "property" &&
      field.valueSemantics?.kind === "property"
        ? comparePropertyValues(
            field.valueSemantics.column,
            leftValue,
            rightValue,
            item.direction,
          )
        : directionMultiplier(item.direction) *
          finiteComparison(
            field.sort.kind === "custom" ? field.sort.compare(left, right) : 0,
          );
    if (compared !== 0) {
      return compared;
    }
  }
  return compareRowIds(descriptor, left, right);
}

function finiteComparison(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function compareEmptyValues(left: unknown, right: unknown): number {
  const leftEmpty = isEmptyValue(left);
  const rightEmpty = isEmptyValue(right);
  return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
}

function comparePropertyValues(
  column: Column,
  left: unknown,
  right: unknown,
  direction: SystemCollectionSortDescriptor["direction"],
): number {
  const multiplier = directionMultiplier(direction);
  if (column.type === "boolean") {
    const leftBoolean = effectiveBooleanValue(left);
    const rightBoolean = effectiveBooleanValue(right);
    if (leftBoolean === undefined || rightBoolean === undefined) {
      if (leftBoolean !== rightBoolean) {
        return leftBoolean === undefined ? 1 : -1;
      }
      return compareText(left, right);
    }
    return multiplier * (Number(leftBoolean) - Number(rightBoolean));
  }
  if (column.type === "select" || column.type === "status") {
    const leftIndex = optionIndex(column, left);
    const rightIndex = optionIndex(column, right);
    if (leftIndex === null || rightIndex === null) {
      if (leftIndex !== rightIndex) {
        return leftIndex === null ? 1 : -1;
      }
    } else if (leftIndex !== rightIndex) {
      return multiplier * (leftIndex - rightIndex);
    }
    return multiplier * compareText(left, right);
  }
  if (column.type === "multi_select" || column.type === "relation") {
    const leftKey = orderedOptionKey(column, left);
    const rightKey = orderedOptionKey(column, right);
    if (leftKey === null || rightKey === null) {
      if (leftKey !== rightKey) {
        return leftKey === null ? 1 : -1;
      }
    } else {
      const compared = compareCodeUnits(leftKey, rightKey);
      if (compared !== 0) {
        return multiplier * compared;
      }
    }
    return multiplier * compareCodeUnits(arrayLexKey(left), arrayLexKey(right));
  }
  if (column.type === "actor" && column.multiple) {
    return (
      multiplier *
      compareText(propertyArray(left)[0] ?? "", propertyArray(right)[0] ?? "")
    );
  }
  return multiplier * comparePropertyScalar(column, left, right);
}

function comparePropertyScalar(
  column: Column,
  left: unknown,
  right: unknown,
): number {
  if (column.type === "number" || column.type === "unique_id") {
    return propertyNumber(column, left) - propertyNumber(column, right);
  }
  if (column.type === "date") {
    return compareCodeUnits(
      dateBounds(left)?.start ?? "",
      dateBounds(right)?.start ?? "",
    );
  }
  return compareText(left, right);
}

function propertyNumber(column: Column, value: unknown): number {
  if (column.type === "unique_id" && typeof value === "string") {
    const prefix = column.prefix?.trim();
    const raw =
      prefix && value.startsWith(`${prefix}-`)
        ? value.slice(prefix.length + 1)
        : value;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMultiValueColumn(column: Column): boolean {
  return (
    column.type === "multi_select" ||
    column.type === "relation" ||
    (column.type === "actor" && Boolean(column.multiple))
  );
}

function propertyArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function optionIndex(column: Column, value: unknown): number | null {
  const index =
    column.options?.findIndex((option) => option.name === value) ?? -1;
  return index >= 0 ? index : null;
}

function orderedOptionKey(column: Column, value: unknown): string | null {
  const indexes = propertyArray(value)
    .map((item) => optionIndex(column, item))
    .filter((index): index is number => index !== null)
    .sort((left, right) => left - right);
  return indexes.length > 0
    ? indexes.map((index) => String(index).padStart(8, "0")).join(",")
    : null;
}

function arrayLexKey(value: unknown): string {
  return propertyArray(value)
    .map((item) => String(item).toLowerCase())
    .sort(compareCodeUnits)
    .join(",");
}

function compareText(left: unknown, right: unknown): number {
  return compareCodeUnits(
    String(left ?? "").toLowerCase(),
    String(right ?? "").toLowerCase(),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directionMultiplier(
  direction: SystemCollectionSortDescriptor["direction"],
): number {
  return direction === "desc" ? -1 : 1;
}

function compareRowIds<Row>(
  descriptor: SystemCollectionPresentationDescriptor<Row>,
  left: Row,
  right: Row,
): number {
  return compareCodeUnits(
    descriptor.getRowId(left),
    descriptor.getRowId(right),
  );
}

function dateContains(value: unknown, target: string | null): boolean {
  const bounds = dateBounds(value);
  return Boolean(
    bounds && target && bounds.start <= target && bounds.end >= target,
  );
}

function dateBounds(value: unknown): { start: string; end: string } | null {
  if (typeof value === "string") {
    return { end: value, start: value };
  }
  if (isDateRangeValue(value)) {
    return { end: value.end, start: value.start };
  }
  return null;
}

function resolveDateFilterValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^@today(?:(?<sign>[+-])(?<days>\d+))?$/);
  if (!match) {
    return value;
  }
  const date = new Date();
  const days = Number(match.groups?.days ?? 0);
  date.setDate(date.getDate() + (match.groups?.sign === "-" ? -days : days));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
