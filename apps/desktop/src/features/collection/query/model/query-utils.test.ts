import { expect, test } from "bun:test";
import type { CollectionSchema } from "@/features/properties";
import {
  filterOpsForField,
  queryField,
  queryFields,
  resolveViewQuery,
  validateQuery,
  viewUpdatePatch,
} from "./query-utils";
import type { CollectionView, StoredViewQueryState } from "./types";

test("queryFields exposes only groupable custom fields for board groups", () => {
  const fields = queryFields(schema(), "group").map((field) => field.name);

  expect(fields).toEqual(["Status", "Stage", "Owner"]);
});

test("validateQuery separates invalid filters, sorts, and non-board grouping", () => {
  const result = validateQuery(schema(), "table", {
    name: "Main",
    type: "table",
    filter: [
      { field: "Ticket", op: "in", values: ["SV-12", 24] },
      { field: "Estimate", op: "gt", value: "not-a-number" },
      { field: "Missing", op: "eq", value: "x" },
    ],
    sort: [
      { field: "created", desc: true },
      { field: "Tags", desc: false },
    ],
    groupBy: "Status",
  });

  expect(result.filter).toEqual([
    { field: "Ticket", op: "in", values: ["SV-12", 24] },
  ]);
  expect(result.invalidFilters).toEqual([
    { field: "Estimate", op: "gt", value: "not-a-number" },
    { field: "Missing", op: "eq", value: "x" },
  ]);
  expect(result.sort).toEqual([{ field: "created", desc: true }]);
  expect(result.invalidSorts).toEqual([{ field: "Tags", desc: false }]);
  expect(result.groupBy).toBeNull();
  expect(result.invalidGroupBy).toBe("Status");
  expect(result.issues.map((issue) => issue.reason)).toEqual([
    "invalid_value",
    "unknown_field",
    "unknown_field",
    "invalid_view_type",
  ]);
});

test("resolveViewQuery merges local overrides and reports stale shared state", () => {
  const view: CollectionView = {
    name: "Board",
    type: "board",
    filter: [{ field: "Status", op: "eq", value: "Todo" }],
    sort: [{ field: "created", desc: true }],
    group_by: "Status",
  };
  const ephemeral: StoredViewQueryState = {
    baseViewHash: "stale",
    updatedAt: "2026-06-23T00:00:00.000Z",
    filter: [{ field: "Owner", op: "eq", value: "me@example.com" }],
    groupBy: null,
  };

  const resolved = resolveViewQuery(schema(), view, ephemeral);

  expect(resolved.persistent.groupBy).toBe("Status");
  expect(resolved.merged).toEqual({
    name: "Board",
    type: "board",
    filter: [{ field: "Owner", op: "eq", value: "me@example.com" }],
    sort: [{ field: "created", desc: true }],
    groupBy: null,
  });
  expect(resolved.hasLocalChanges).toBe(true);
  expect(resolved.sharedChanged).toBe(true);
  expect(viewUpdatePatch(resolved.merged)).toEqual({
    filter: [{ field: "Owner", op: "eq", value: "me@example.com" }],
    sort: [{ field: "created", desc: true }],
    group_by: null,
  });
});

test("properties of a newer Svode version are not offered to filter, sort or group", () => {
  const newer: CollectionSchema = {
    ...schema(),
    columns: [
      ...schema().columns,
      { name: "Score", type: "text", newer: true },
      { name: "Lead", type: "status", newer: true },
    ],
  };

  for (const context of ["filter", "sort", "group"] as const) {
    const names = queryFields(newer, context).map((field) => field.name);
    expect(names.includes("Score")).toBe(false);
    expect(names.includes("Lead")).toBe(false);
  }
  const result = validateQuery(newer, "table", {
    name: "Main",
    type: "table",
    filter: [{ field: "Score", op: "contains", value: "x" }],
    sort: [{ field: "Score" }],
    groupBy: null,
  });
  expect(result.filter).toEqual([]);
  expect(result.sort).toEqual([]);
  expect(result.issues.map((issue) => issue.reason)).toEqual([
    "unknown_field",
    "unknown_field",
  ]);
});

test("a status with an option of a newer group offers no group operators", () => {
  const known = queryField(schema(), "Status", "filter");
  expect(known && filterOpsForField(known).includes("group_eq")).toBe(true);

  const newer: CollectionSchema = {
    ...schema(),
    columns: schema().columns.map((column) =>
      column.name === "Status"
        ? {
            ...column,
            options: [
              ...(column.options ?? []),
              { name: "Blocked", group: "blocked" as "todo" },
            ],
          }
        : column,
    ),
  };
  const field = queryField(newer, "Status", "filter");
  expect(field?.name).toBe("Status");
  const ops = field ? filterOpsForField(field) : [];
  expect(ops.some((op) => op.startsWith("group_"))).toBe(false);
  expect(ops.includes("eq")).toBe(true);
});

function schema(): CollectionSchema {
  return {
    columns: [
      {
        name: "Status",
        type: "status",
        options: [
          { name: "Todo", group: "todo", color: "gray" },
          { name: "Doing", group: "in_progress", color: "blue" },
        ],
      },
      { name: "Stage", type: "select" },
      { name: "Owner", type: "actor", multiple: false },
      { name: "Reviewers", type: "actor", multiple: true },
      { name: "Tags", type: "multi_select" },
      { name: "Estimate", type: "number" },
      { name: "Ticket", type: "unique_id", prefix: "SV" },
    ],
    views: [],
  };
}
