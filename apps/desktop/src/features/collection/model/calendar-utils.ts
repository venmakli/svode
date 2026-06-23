import type { CollectionView } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type { CollectionSchema, Column } from "@/features/properties";
import { isDateRangeValue } from "@/features/properties";
import type { CalendarDateValue, CalendarScope } from "./calendar-types";

const SYSTEM_CARD_FIELDS = new Set([
  "title",
  "icon",
  "description",
  "created",
  "updated",
]);

export const calendarScopes: CalendarScope[] = ["month", "week", "day", "list"];

export function normalizeCalendarScope(value: unknown): CalendarScope {
  return calendarScopes.includes(value as CalendarScope)
    ? (value as CalendarScope)
    : "month";
}

export function calendarDateColumn(
  view: CollectionView,
  schema: CollectionSchema,
) {
  const configured =
    typeof view.date_field === "string" ? view.date_field : null;
  return (
    schema.columns.find(
      (column) => column.type === "date" && column.name === configured,
    ) ??
    schema.columns.find((column) => column.type === "date") ??
    null
  );
}

export function normalizeCalendarCardFields(
  view: CollectionView,
  schema: CollectionSchema,
) {
  const configured = Array.isArray(view.card_fields)
    ? (view.card_fields as unknown[]).map(String)
    : [
        "icon",
        "title",
        "description",
        ...schema.columns.slice(0, 4).map((column) => column.name),
      ];
  const allowed = new Set([
    "title",
    "icon",
    "description",
    ...schema.columns.map((column) => column.name),
  ]);
  const fields = configured.filter((field) => allowed.has(field));
  return fields.includes("title") ? fields : ["title", ...fields];
}

export function calendarCustomFields(
  fields: string[],
  schema: CollectionSchema,
  dateField: string,
) {
  return fields
    .filter((field) => !SYSTEM_CARD_FIELDS.has(field) && field !== dateField)
    .map((field) => schema.columns.find((column) => column.name === field))
    .filter((column): column is Column => Boolean(column));
}

export function parseCalendarDateValue(
  value: unknown,
): CalendarDateValue | null {
  if (isDateRangeValue(value)) {
    const start = normalizeStoredDateString(value.start);
    const end = normalizeStoredDateString(value.end);
    if (!start || !end) return null;
    const hasTime = start.includes("T") || end.includes("T");
    return {
      start,
      end,
      allDay: !hasTime,
      range: true,
      kind: hasTime ? "datetime-range" : "date-range",
    };
  }
  if (typeof value !== "string") return null;
  const start = normalizeStoredDateString(value);
  if (!start) return null;
  const hasTime = start.includes("T");
  return {
    start,
    end: null,
    allDay: !hasTime,
    range: false,
    kind: hasTime ? "datetime" : "date",
  };
}

export function hiddenNoDateCount(entries: Entry[], dateColumn: Column) {
  return entries.filter(
    (entry) => !parseCalendarDateValue(entry.meta.extra?.[dateColumn.name]),
  ).length;
}

export function dateValueFromClick(dateStr: string, allDay: boolean) {
  return allDay ? dateOnly(dateStr) : dateTimeLocal(dateStr);
}

export function dateValueFromSelection(
  selection: {
    allDay: boolean;
    startStr: string;
    endStr: string;
  },
  column: Column,
) {
  const allDay = selection.allDay;
  const rangeByDefault = column.rangeByDefault;
  const timeByDefault = column.timeByDefault;
  const start =
    allDay && !timeByDefault
      ? dateOnly(selection.startStr)
      : dateTimeLocal(selection.startStr);
  const exclusiveEnd = allDay
    ? dateOnly(selection.endStr)
    : dateTimeLocal(selection.endStr);
  const end =
    allDay && !timeByDefault ? addDaysIso(exclusiveEnd, -1) : exclusiveEnd;
  if (!rangeByDefault && start === end) return start;
  return { start, end };
}

export function updateEntryDateValue(
  entry: Entry,
  field: string,
  value: unknown,
) {
  return {
    ...entry,
    meta: {
      ...entry.meta,
      extra: {
        ...(entry.meta.extra ?? {}),
        [field]: value,
      },
    },
  };
}

function normalizeStoredDateString(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed.includes("T") ? trimmed : `${trimmed}T00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return trimmed;
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function dateTimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return isoDateTime(date);
}

function isoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isoDateTime(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${isoDate(date)}T${hours}:${minutes}`;
}

export function addDaysIso(value: string, amount: number) {
  const date = new Date(`${value.slice(0, 10)}T00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return isoDate(addDays(date, amount));
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}
