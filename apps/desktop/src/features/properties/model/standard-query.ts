import { isDateRangeValue, isEmptyValue } from "../lib/utils";
import { effectiveBooleanValue } from "./boolean";
import {
  resolveStandardPropertyColumn,
  type CollectionPropertyDefinition,
  type CollectionPropertyFilterRule,
} from "./collection-property";
import type { Column, PropertyType } from "./types";

const FILTER_OPERATORS_BY_TYPE: Record<PropertyType, readonly string[]> = {
  actor: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  boolean: ["eq", "neq"],
  date: ["eq", "neq", "before", "after", "is_empty", "is_not_empty"],
  email: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  multi_select: [
    "contains",
    "not_contains",
    "contains_any",
    "not_contains_any",
    "is_empty",
    "is_not_empty",
  ],
  number: ["eq", "neq", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"],
  phone: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  relation: [
    "contains",
    "not_contains",
    "contains_any",
    "not_contains_any",
    "is_empty",
    "is_not_empty",
  ],
  select: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
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
  text: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
  unique_id: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  url: ["contains", "eq", "neq", "not_contains", "is_empty", "is_not_empty"],
};

export function standardPropertyFilterOperators<Row>(
  property: CollectionPropertyDefinition<Row>,
): readonly string[] {
  const column = resolveStandardPropertyColumn(property);
  if (!column) return [];
  if (column.type === "actor" && column.multiple) {
    return FILTER_OPERATORS_BY_TYPE.multi_select;
  }
  return FILTER_OPERATORS_BY_TYPE[column.type];
}

export function createDefaultStandardPropertyFilterRule<Row>(
  property: CollectionPropertyDefinition<Row>,
): CollectionPropertyFilterRule | null {
  const column = resolveStandardPropertyColumn(property);
  if (!column) return null;
  const operator =
    column.type === "text" ||
    column.type === "url" ||
    column.type === "email" ||
    column.type === "phone" ||
    column.type === "multi_select" ||
    (column.type === "actor" && column.multiple)
      ? "contains"
      : "eq";
  return { operator };
}

export function validateStandardPropertyFilterRule<Row>(
  property: CollectionPropertyDefinition<Row>,
  rule: CollectionPropertyFilterRule,
): boolean {
  const column = resolveStandardPropertyColumn(property);
  if (
    !column ||
    !standardPropertyFilterOperators(property).includes(rule.operator)
  ) {
    return false;
  }
  const values = filterPayloadValues(rule);
  if (!values) return false;
  if (rule.operator === "is_empty" || rule.operator === "is_not_empty") {
    return values.length === 0;
  }
  const raw = values[0];
  if (
    column.type === "select" ||
    column.type === "multi_select" ||
    column.type === "relation"
  ) {
    return values.every(
      (value) =>
        typeof value === "string" &&
        (column.type === "relation" ||
          column.options?.some((option) => option.name === value)),
    );
  }
  if (column.type === "status") {
    if (rule.operator.startsWith("group_")) {
      return values.every(
        (value) =>
          value === "todo" || value === "in_progress" || value === "done",
      );
    }
    return values.every(
      (value) =>
        typeof value === "string" &&
        column.options?.some((option) => option.name === value),
    );
  }
  if (column.type === "actor") {
    return values.every((value) => typeof value === "string");
  }
  if (column.type === "number") {
    return typeof raw === "number" && Number.isFinite(raw);
  }
  if (column.type === "unique_id") {
    return values.every((value) => isValidUniqueIdFilterValue(column, value));
  }
  if (column.type === "boolean") return typeof raw === "boolean";
  if (column.type === "date") {
    return (
      typeof raw === "string" && (isIsoDateCell(raw) || isValidTodayMacro(raw))
    );
  }
  return typeof raw === "string";
}

export function matchesStandardPropertyFilter<Row>(
  property: CollectionPropertyDefinition<Row>,
  row: Row,
  rule: CollectionPropertyFilterRule,
): boolean {
  const column = resolveStandardPropertyColumn(property);
  if (!column) return false;
  const value = property.getValue(row);
  const values = rule.values ?? (rule.value === undefined ? [] : [rule.value]);
  const wanted = values[0];
  const empty = isEmptyValue(value);

  if (
    column.type === "boolean" &&
    (rule.operator === "eq" || rule.operator === "neq")
  ) {
    const effective = effectiveBooleanValue(value);
    const expected = effectiveBooleanValue(wanted);
    if (effective === undefined || expected === undefined) return false;
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
      if (value === null || value === undefined) return false;
      return column.type === "date"
        ? dateContains(value, resolveDateFilterValue(wanted))
        : comparePropertyScalar(column, value, wanted) === 0;
    case "neq":
      if (empty) return false;
      return column.type === "date"
        ? !dateContains(value, resolveDateFilterValue(wanted))
        : comparePropertyScalar(column, value, wanted) !== 0;
    case "contains":
      return isMultiValueColumn(column)
        ? propertyArray(value).some((item) => item === wanted)
        : !empty &&
            String(value)
              .toLowerCase()
              .includes(String(wanted ?? "").toLowerCase());
    case "not_contains":
      return (
        !empty &&
        (isMultiValueColumn(column)
          ? !propertyArray(value).some((item) => item === wanted)
          : !String(value)
              .toLowerCase()
              .includes(String(wanted ?? "").toLowerCase()))
      );
    case "in":
      return (
        !empty &&
        values.some(
          (candidate) => comparePropertyScalar(column, value, candidate) === 0,
        )
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
      if (empty) return false;
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
      const group = column.options?.find(
        (candidate) => candidate.name === value,
      )?.group;
      const matches = values.includes(group);
      return rule.operator === "group_eq" || rule.operator === "group_in"
        ? matches
        : !empty && !matches;
    }
    default:
      return false;
  }
}

export function compareStandardPropertyValues<Row>(
  property: CollectionPropertyDefinition<Row>,
  left: unknown,
  right: unknown,
  direction: "asc" | "desc",
): number {
  const column = resolveStandardPropertyColumn(property);
  if (!column) return 0;
  const multiplier = direction === "desc" ? -1 : 1;
  if (column.type !== "boolean") {
    const emptyOrder = compareEmptyValues(left, right);
    if (emptyOrder !== 0 || isEmptyValue(left)) return emptyOrder;
  }
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
      if (leftIndex !== rightIndex) return leftIndex === null ? 1 : -1;
    } else if (leftIndex !== rightIndex) {
      return multiplier * (leftIndex - rightIndex);
    }
    return multiplier * compareText(left, right);
  }
  if (column.type === "multi_select" || column.type === "relation") {
    const leftKey = orderedOptionKey(column, left);
    const rightKey = orderedOptionKey(column, right);
    if (leftKey === null || rightKey === null) {
      if (leftKey !== rightKey) return leftKey === null ? 1 : -1;
    } else {
      const compared = compareCodeUnits(leftKey, rightKey);
      if (compared !== 0) return multiplier * compared;
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

function filterPayloadValues(
  rule: CollectionPropertyFilterRule,
): readonly unknown[] | null {
  if (rule.operator === "is_empty" || rule.operator === "is_not_empty") {
    return rule.value === undefined && rule.values === undefined ? [] : null;
  }
  const multi = [
    "in",
    "not_in",
    "contains_any",
    "not_contains_any",
    "group_in",
    "group_not_in",
  ].includes(rule.operator);
  if (multi) {
    const values =
      rule.values ??
      (Array.isArray(rule.value)
        ? rule.value
        : rule.value === undefined
          ? []
          : [rule.value]);
    return values.length > 0 ? values : null;
  }
  if (rule.values) return rule.values.length === 1 ? rule.values : null;
  if (rule.value === undefined || Array.isArray(rule.value)) return null;
  return [rule.value];
}

function isValidUniqueIdFilterValue(column: Column, value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1;
  }
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const prefix = column.prefix?.trim();
  const numeric = prefix
    ? trimmed.startsWith(`${prefix}-`)
      ? trimmed.slice(prefix.length + 1)
      : ""
    : trimmed;
  return (
    /^\d+$/.test(numeric) &&
    BigInt(numeric) >= 1n &&
    BigInt(numeric) <= 18_446_744_073_709_551_615n
  );
}

function isValidTodayMacro(value: string): boolean {
  if (value === "@today") return true;
  const offset = value.match(/^@today[+-](\d+)$/)?.[1];
  return Boolean(offset && BigInt(offset) <= 9_223_372_036_854_775_807n);
}

function isIsoDateCell(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
  );
  if (!match) return false;
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue = "0",
    minuteValue = "0",
    secondValue = "0",
  ] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number(hourValue) <= 23 &&
    Number(minuteValue) <= 59 &&
    Number(secondValue) <= 59
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function compareEmptyValues(left: unknown, right: unknown): number {
  const leftEmpty = isEmptyValue(left);
  const rightEmpty = isEmptyValue(right);
  return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
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
  const prefix = column.prefix?.trim();
  const raw =
    column.type === "unique_id" &&
    typeof value === "string" &&
    prefix &&
    value.startsWith(`${prefix}-`)
      ? value.slice(prefix.length + 1)
      : value;
  const parsed = Number(raw);
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

function dateContains(value: unknown, target: string | null): boolean {
  const bounds = dateBounds(value);
  return Boolean(
    bounds && target && bounds.start <= target && bounds.end >= target,
  );
}

function dateBounds(value: unknown): { start: string; end: string } | null {
  if (typeof value === "string") return { end: value, start: value };
  return isDateRangeValue(value)
    ? { end: value.end, start: value.start }
    : null;
}

function resolveDateFilterValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^@today(?:([+-])(\d+))?$/);
  if (!match) return value;
  const date = new Date();
  const days = Number(match[2] ?? 0);
  date.setDate(date.getDate() + (match[1] === "-" ? -days : days));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
