import { expect, test } from "bun:test";
import type { CollectionSchema } from "@/features/properties";
import {
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
