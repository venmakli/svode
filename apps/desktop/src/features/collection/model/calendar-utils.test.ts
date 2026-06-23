import { expect, test } from "bun:test";
import type { Entry } from "@/features/entry";
import type { CollectionSchema, Column } from "@/features/properties";
import type { CollectionView } from "@/features/collection/query/model";
import {
  buildCalendarEvents,
  dateValueFromSelection,
  hiddenNoDateCount,
  parseCalendarDateValue,
  visibleEventCount,
} from "./calendar-utils";

test("parseCalendarDateValue distinguishes date and datetime values", () => {
  expect(parseCalendarDateValue("2026-06-20")).toEqual({
    start: "2026-06-20",
    end: null,
    allDay: true,
    range: false,
    kind: "date",
  });
  expect(parseCalendarDateValue("2026-06-20T09:30")).toEqual({
    start: "2026-06-20T09:30",
    end: null,
    allDay: false,
    range: false,
    kind: "datetime",
  });
});

test("dateValueFromSelection stores all-day range ends inclusively", () => {
  const value = dateValueFromSelection(
    {
      allDay: true,
      startStr: "2026-06-20",
      endStr: "2026-06-23",
    } as Parameters<typeof dateValueFromSelection>[0],
    dateColumn({ rangeByDefault: true }),
  );

  expect(value).toEqual({ start: "2026-06-20", end: "2026-06-22" });
});

test("buildCalendarEvents converts stored ranges to FullCalendar events", () => {
  const entries = [
    entry("tasks/a.md", {
      Due: { start: "2026-06-20", end: "2026-06-22" },
      Status: "Doing",
    }),
    entry("tasks/b.md", { Status: "Todo" }),
  ];
  const events = buildCalendarEvents({
    entries,
    view: calendarView(),
    schema: schema(),
    dateColumn: dateColumn(),
    cardFields: ["title", "Status"],
    customColumns: [statusColumn()],
    nestedCollectionPaths: new Set(["tasks/a"]),
  });

  expect(events.length).toBe(1);
  expect(events[0]?.id).toBe("tasks/a.md");
  expect(events[0]?.end).toBe("2026-06-23");
  expect(events[0]?.allDay).toBe(true);
  expect(events[0]?.extendedProps.model.color).toBe("blue");
  expect(events[0]?.extendedProps.model.nestedCollection).toBe(true);
  expect(hiddenNoDateCount(entries, dateColumn())).toBe(1);
  expect(
    visibleEventCount(events, {
      start: new Date("2026-06-21T00:00:00"),
      end: new Date("2026-06-22T00:00:00"),
    }),
  ).toBe(1);
});

function schema(): CollectionSchema {
  return {
    columns: [dateColumn(), statusColumn()],
    views: [calendarView()],
  };
}

function calendarView(): CollectionView {
  return {
    name: "Calendar",
    type: "calendar",
    date_field: "Due",
    color_field: "Status",
  };
}

function dateColumn(patch: Partial<Column> = {}): Column {
  return { name: "Due", type: "date", ...patch };
}

function statusColumn(): Column {
  return {
    name: "Status",
    type: "status",
    options: [
      { name: "Todo", group: "todo", color: "gray" },
      { name: "Doing", group: "in_progress", color: "blue" },
    ],
  };
}

function entry(path: string, extra: Record<string, unknown>): Entry {
  return {
    path,
    body: "",
    meta: {
      title: path.split("/").at(-1) ?? path,
      icon: null,
      description: null,
      cover: null,
      created: "2026-06-20T00:00:00.000Z",
      updated: "2026-06-21T00:00:00.000Z",
      extra,
    },
  };
}
