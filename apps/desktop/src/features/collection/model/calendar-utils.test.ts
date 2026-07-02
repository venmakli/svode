import { expect, test } from "bun:test";
import type { Entry } from "@/features/entry";
import type { Column } from "@/features/properties";
import {
  calendarCustomFields,
  dateValueFromSelection,
  hiddenNoDateCount,
  normalizeCalendarCardFields,
  parseCalendarDateValue,
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

test("hiddenNoDateCount ignores entries without date values", () => {
  expect(
    hiddenNoDateCount(
      [entry("tasks/a.md", { Due: "2026-06-20" }), entry("tasks/b.md", {})],
      dateColumn(),
    ),
  ).toBe(1);
});

test("calendar card fields preserve visible system meta fields", () => {
  const view = {
    name: "Calendar",
    type: "calendar",
    card_fields: ["icon", "title", "created", "updated", "Due"],
  } as const;
  const schema = { columns: [dateColumn()] };
  const fields = normalizeCalendarCardFields(view, schema);

  expect(fields).toEqual(["icon", "title", "created", "updated", "Due"]);
  expect(calendarCustomFields(fields, schema, "Due")).toEqual([
    { name: "created", type: "date", display: "medium" },
    { name: "updated", type: "date", display: "medium" },
  ]);
});

function dateColumn(patch: Partial<Column> = {}): Column {
  return { name: "Due", type: "date", ...patch };
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
