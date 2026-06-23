import type { DateSelectArg, EventDropArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import type { CSSProperties } from "react";
import type { CollectionView } from "@/features/collection/query";
import { normalizeEntryPath } from "@/features/collection/lib/utils";
import type { Entry } from "@/features/entry";
import type {
  CollectionSchema,
  Column,
  PropertyOption,
} from "@/features/properties";
import { isDateRangeValue, optionByName } from "@/features/properties";
import { entryCollectionPath } from "../table/utils";
import type {
  CalendarDateValue,
  CalendarEventInput,
  CalendarEventModel,
  CalendarScope,
} from "./types";

const SYSTEM_CARD_FIELDS = new Set([
  "title",
  "icon",
  "description",
  "created",
  "updated",
]);

export const calendarScopes: CalendarScope[] = ["month", "week", "day", "list"];

export function fullCalendarViewForScope(scope: CalendarScope) {
  const views: Record<CalendarScope, string> = {
    month: "dayGridMonth",
    week: "timeGridWeek",
    day: "timeGridDay",
    list: "listMonth",
  };
  return views[scope];
}

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

export function buildCalendarEvents({
  entries,
  view,
  schema,
  dateColumn,
  cardFields,
  customColumns,
  nestedCollectionPaths,
}: {
  entries: Entry[];
  view: CollectionView;
  schema: CollectionSchema;
  dateColumn: Column;
  cardFields: string[];
  customColumns: Column[];
  nestedCollectionPaths: Set<string>;
}): CalendarEventInput[] {
  return entries.reduce<CalendarEventInput[]>((result, entry) => {
    const value = parseCalendarDateValue(entry.meta.extra?.[dateColumn.name]);
    if (!value) return result;
    const color = eventColor(view, schema, entry);
    const model: CalendarEventModel = {
      entry,
      value,
      dateField: dateColumn.name,
      cardFields,
      customColumns,
      folder: isFolderEntry(entry),
      nestedCollection: nestedCollectionPaths.has(entryCollectionPath(entry)),
      color,
    };
    result.push({
      id: entry.path,
      title: entry.meta.title,
      start: value.start,
      end:
        value.range && value.end
          ? value.allDay
            ? addDaysIso(value.end, 1)
            : value.end
          : undefined,
      allDay: value.allDay,
      editable: true,
      durationEditable: true,
      backgroundColor: "transparent",
      borderColor: "transparent",
      textColor: "inherit",
      classNames: ["svode-calendar-event"],
      extendedProps: { model },
    });
    return result;
  }, []);
}

export function hiddenNoDateCount(entries: Entry[], dateColumn: Column) {
  return entries.filter(
    (entry) => !parseCalendarDateValue(entry.meta.extra?.[dateColumn.name]),
  ).length;
}

export function visibleEventCount(
  events: CalendarEventInput[],
  range: { start: Date; end: Date } | null,
) {
  if (!range) return events.length;
  return events.filter((event) => {
    const start = toDate(event.start);
    if (!start) return false;
    const end = toDate(event.end);
    if (!end) return start >= range.start && start < range.end;
    return start < range.end && end > range.start;
  }).length;
}

export function dateValueFromClick(dateStr: string, allDay: boolean) {
  return allDay ? dateOnly(dateStr) : dateTimeLocal(dateStr);
}

export function dateValueFromSelection(
  selection: DateSelectArg,
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

export function valueFromEventDrop(info: EventDropArg) {
  const model = info.oldEvent.extendedProps.model as
    | CalendarEventModel
    | undefined;
  if (!model || !info.event.start) return null;
  if (!model.value.range) {
    return storageScalarFromEvent(info.event.start, info.event.allDay);
  }
  const end =
    info.event.end ?? defaultEventEnd(info.event.start, info.event.allDay);
  return {
    start: storageScalarFromEvent(info.event.start, info.event.allDay),
    end: storageEndFromEvent(end, info.event.allDay),
  };
}

export function valueFromEventResize(info: EventResizeDoneArg) {
  const model = info.oldEvent.extendedProps.model as
    | CalendarEventModel
    | undefined;
  if (!model || !info.event.start) return null;
  const end =
    info.event.end ?? defaultEventEnd(info.event.start, info.event.allDay);
  return {
    start: storageScalarFromEvent(info.event.start, info.event.allDay),
    end: storageEndFromEvent(end, info.event.allDay),
  };
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

export function eventColorStyle(color: string | null) {
  if (!color) {
    return {
      "--calendar-event-color": "var(--primary)",
      "--calendar-event-soft": "var(--accent)",
    } as CSSProperties;
  }
  return {
    "--calendar-event-color": `var(--property-${color})`,
    "--calendar-event-soft": `var(--property-${color}-soft)`,
  } as CSSProperties;
}

export function isFolderEntry(entry: Entry) {
  return normalizeEntryPath(entry.path).toLowerCase().endsWith("/readme.md");
}

function eventColor(
  view: CollectionView,
  schema: CollectionSchema,
  entry: Entry,
) {
  const colorField =
    typeof view.color_field === "string" ? view.color_field : null;
  if (!colorField) return null;
  const column = schema.columns.find((item) => item.name === colorField);
  if (!column || !["select", "status"].includes(column.type)) return null;
  const option = optionByName(column, entry.meta.extra?.[column.name]);
  return optionColorName(option);
}

function optionColorName(option: PropertyOption | undefined) {
  return option?.color ?? null;
}

function normalizeStoredDateString(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed.includes("T") ? trimmed : `${trimmed}T00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return trimmed;
}

function storageScalarFromEvent(date: Date, allDay: boolean) {
  return allDay ? isoDate(date) : isoDateTime(date);
}

function storageEndFromEvent(date: Date, allDay: boolean) {
  return allDay ? isoDate(addDays(date, -1)) : isoDateTime(date);
}

function defaultEventEnd(start: Date, allDay: boolean) {
  return addDays(start, allDay ? 1 : 0);
}

function toDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const date = new Date(value.includes("T") ? value : `${value}T00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
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

function addDaysIso(value: string, amount: number) {
  const date = new Date(`${value.slice(0, 10)}T00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return isoDate(addDays(date, amount));
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}
