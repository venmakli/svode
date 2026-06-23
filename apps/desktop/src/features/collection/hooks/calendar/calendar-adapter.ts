import type { EventDropArg, EventInput } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import type { CSSProperties } from "react";
import type { CollectionView } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type {
  CollectionSchema,
  Column,
  PropertyOption,
} from "@/features/properties";
import { optionByName } from "@/features/properties";
import { entryCollectionPath, isFolderEntry } from "../../lib/entry-tree";
import type {
  CalendarEventModel,
  CalendarScope,
} from "../../model/calendar-types";
import { addDaysIso, parseCalendarDateValue } from "../../model/calendar-utils";

export interface CalendarEventInput extends EventInput {
  extendedProps: {
    model: CalendarEventModel;
  };
}

export function fullCalendarViewForScope(scope: CalendarScope) {
  const views: Record<CalendarScope, string> = {
    month: "dayGridMonth",
    week: "timeGridWeek",
    day: "timeGridDay",
    list: "listMonth",
  };
  return views[scope];
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

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}
