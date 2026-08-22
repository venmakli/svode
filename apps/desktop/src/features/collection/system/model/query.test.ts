import { expect, test } from "bun:test";

import {
  applySystemCollectionQuery,
  normalizeSystemCollectionSearchText,
  validateSystemCollectionQuery,
} from "./query";
import type {
  SystemCollectionFieldDescriptor,
  SystemCollectionPresentationDescriptor,
  SystemCollectionQueryState,
} from "./types";

interface TestRow {
  active: boolean;
  due?: string | { start: string; end: string };
  enabled?: unknown;
  id: string;
  name: string;
  priority?: string;
  score?: number | null;
  status?: string;
  tags?: string[];
}

const priorityColumn = {
  name: "Priority",
  options: [{ name: "Low" }, { name: "High" }],
  type: "select" as const,
};

const fields: readonly SystemCollectionFieldDescriptor<TestRow>[] = [
  {
    filter: { kind: "property" },
    getValue: (row) => row.enabled,
    key: "enabled",
    label: "Enabled",
    sort: { kind: "property" },
    valueSemantics: {
      column: { name: "Enabled", type: "boolean" },
      kind: "property",
    },
  },
  {
    filter: { kind: "property" },
    getValue: (row) => row.name,
    key: "name",
    label: "Name",
    sort: { kind: "property" },
    valueSemantics: {
      column: { name: "Name", type: "text" },
      kind: "property",
    },
  },
  {
    filter: { kind: "property" },
    getValue: (row) => row.score,
    key: "score",
    label: "Score",
    sort: { kind: "property" },
    valueSemantics: {
      column: { name: "Score", type: "number" },
      kind: "property",
    },
  },
  {
    filter: { kind: "property" },
    getValue: (row) => row.priority,
    key: "priority",
    label: "Priority",
    sort: { kind: "property" },
    valueSemantics: { column: priorityColumn, kind: "property" },
  },
  {
    filter: { kind: "property" },
    getValue: (row) => row.tags,
    key: "tags",
    label: "Tags",
    sort: { kind: "property" },
    valueSemantics: {
      column: {
        name: "Tags",
        options: [{ name: "Bug" }, { name: "Feature" }],
        type: "multi_select",
      },
      kind: "property",
    },
  },
  {
    filter: { kind: "property" },
    getValue: (row) => row.status,
    key: "status",
    label: "Status",
    sort: { kind: "property" },
    valueSemantics: {
      column: {
        name: "Status",
        options: [
          { group: "todo", name: "Todo" },
          { group: "in_progress", name: "Doing" },
          { group: "done", name: "Done" },
        ],
        type: "status",
      },
      kind: "property",
    },
  },
  {
    filter: { kind: "property" },
    getValue: (row) => row.due,
    key: "due",
    label: "Due",
    sort: { kind: "property" },
    valueSemantics: {
      column: { name: "Due", type: "date" },
      kind: "property",
    },
  },
];

function descriptor(
  overrides: Partial<SystemCollectionPresentationDescriptor<TestRow>> = {},
): SystemCollectionPresentationDescriptor<TestRow> {
  return {
    fields,
    getRowId: (row) => row.id,
    id: "people",
    label: "People",
    layout: {
      getTitle: (row) => row.name,
      kind: "list",
      visibleFields: [],
    },
    query: {
      fixedPredicate: (row) => row.active,
      getSearchText: (row) => row.name,
    },
    ...overrides,
  };
}

function query(
  overrides: Partial<SystemCollectionQueryState> = {},
): SystemCollectionQueryState {
  return { filters: [], search: "", sort: [], ...overrides };
}

test("search normalization is deterministic Unicode NFKC whitespace substring matching", () => {
  expect(normalizeSystemCollectionSearchText("  Ａlpha\t  TASK  ")).toBe(
    "alpha task",
  );

  const result = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({ search: " alpha   task " }),
    rows: [
      {
        active: true,
        id: "fullwidth",
        name: "Ａlpha Task",
      },
      { active: true, id: "other", name: "Beta" },
    ],
  });

  expect(result.rows.map((row) => row.id)).toEqual(["fullwidth"]);
});

test("pipeline applies fixed predicate, search, AND filters, then explicit sort", () => {
  const result = applySystemCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", fieldKey: "score" }],
        fixedPredicate: (row) => row.active,
        getSearchText: (row) => row.name,
      },
    }),
    query: query({
      filters: [
        { fieldKey: "score", operator: "gte", value: 2 },
        { fieldKey: "tags", operator: "contains", value: "Feature" },
      ],
      search: "task",
      sort: [{ direction: "asc", fieldKey: "name" }],
    }),
    rows: [
      {
        active: true,
        id: "z",
        name: "Zulu task",
        score: 10,
        tags: ["Feature"],
      },
      {
        active: true,
        id: "a",
        name: "Alpha task",
        score: 2,
        tags: ["Feature"],
      },
      {
        active: false,
        id: "hidden",
        name: "Aardvark task",
        score: 20,
        tags: ["Feature"],
      },
      {
        active: true,
        id: "filtered",
        name: "Beta task",
        score: 5,
        tags: ["Bug"],
      },
    ],
  });

  expect(result.sourceRows.map((row) => row.id)).toEqual([
    "z",
    "a",
    "filtered",
  ]);
  expect(result.rows.map((row) => row.id)).toEqual(["a", "z"]);
});

test("default field sort and defaultCompare apply only without explicit user sort", () => {
  const rows = [
    { active: true, id: "b", name: "Beta", score: 2 },
    { active: true, id: "a", name: "Alpha", score: 1 },
  ];
  const defaultField = applySystemCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", fieldKey: "score" }],
      },
    }),
    query: query(),
    rows,
  });
  const userSort = applySystemCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", fieldKey: "score" }],
      },
    }),
    query: query({
      sort: [{ direction: "asc", fieldKey: "name" }],
    }),
    rows,
  });
  const defaultCompare = applySystemCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultCompare: (left, right) => left.score! - right.score!,
      },
    }),
    query: query(),
    rows,
  });

  expect(defaultField.rows.map((row) => row.id)).toEqual(["b", "a"]);
  expect(userSort.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(defaultCompare.rows.map((row) => row.id)).toEqual(["a", "b"]);
});

test("property adapters match Collection option, group, multi-value, and date fixtures", () => {
  const rows: TestRow[] = [
    {
      active: true,
      due: { end: "2026-01-20", start: "2026-01-10" },
      id: "a",
      name: "A",
      priority: "High",
      status: "Doing",
      tags: ["Feature"],
    },
    {
      active: true,
      due: "2026-01-05",
      id: "b",
      name: "B",
      priority: "Low",
      status: "Doing",
      tags: ["Feature"],
    },
    {
      active: true,
      due: { end: "2026-02-03", start: "2026-02-01" },
      id: "c",
      name: "C",
      priority: "Unknown",
      status: "Doing",
      tags: ["Feature"],
    },
    {
      active: true,
      id: "d",
      name: "D",
      status: "Doing",
      tags: ["Feature"],
    },
    {
      active: true,
      due: "2025-12-31",
      id: "e",
      name: "E",
      priority: "Low",
      status: "Todo",
      tags: ["Feature"],
    },
  ];
  const filtered = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [
        { fieldKey: "status", operator: "group_eq", value: "in_progress" },
        { fieldKey: "tags", operator: "contains", value: "Feature" },
      ],
      sort: [{ direction: "asc", fieldKey: "priority" }],
    }),
    rows,
  });
  const dateEquals = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ fieldKey: "due", operator: "eq", value: "2026-01-15" }],
    }),
    rows,
  });
  const dateBefore = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ fieldKey: "due", operator: "before", value: "2026-01-06" }],
      sort: [{ direction: "asc", fieldKey: "name" }],
    }),
    rows,
  });

  expect(filtered.rows.map((row) => row.id)).toEqual(["b", "a", "c", "d"]);
  expect(dateEquals.rows.map((row) => row.id)).toEqual(["a"]);
  expect(dateBefore.rows.map((row) => row.id)).toEqual(["b", "e"]);
});

test("property adapters reject backend-invalid payloads and never match null as zero", () => {
  const invalidSortField: SystemCollectionFieldDescriptor<TestRow> = {
    getValue: (row) => row.name,
    key: "invalid-sort",
    label: "Invalid sort",
    sort: { kind: "property" },
    valueSemantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const invalid = validateSystemCollectionQuery(
    descriptor({ fields: [...fields, invalidSortField] }),
    query({
      filters: [
        { fieldKey: "score", operator: "eq", values: [1, 2] },
        { fieldKey: "score", operator: "eq", value: "2" },
        { fieldKey: "name", operator: "is_empty", value: "unexpected" },
        { fieldKey: "due", operator: "eq", value: "2026-02-31" },
        {
          fieldKey: "due",
          operator: "eq",
          value: "@today+9223372036854775808",
        },
        { fieldKey: "priority", operator: "eq", value: "Unknown" },
      ],
      sort: [{ direction: "asc", fieldKey: "invalid-sort" }],
    }),
  );
  const zero = applySystemCollectionQuery({
    descriptor: descriptor({ query: {} }),
    query: query({
      filters: [{ fieldKey: "score", operator: "eq", value: 0 }],
    }),
    rows: [
      { active: true, id: "null", name: "Null", score: null },
      { active: true, id: "zero", name: "Zero", score: 0 },
    ],
  });
  const emptyText = validateSystemCollectionQuery(
    descriptor(),
    query({
      filters: [{ fieldKey: "name", operator: "eq", value: "" }],
    }),
  );

  expect(invalid.query).toEqual(query());
  expect(invalid.issues.map((issue) => issue.reason)).toEqual([
    "invalid-value",
    "invalid-value",
    "invalid-value",
    "invalid-value",
    "invalid-value",
    "invalid-value",
    "unsupported-sort",
  ]);
  expect(zero.rows.map((row) => row.id)).toEqual(["zero"]);
  expect(emptyText.reset).toBe(false);
});

test("field sort keeps empty values last in both directions and uses rowId ties", () => {
  const rows = [
    { active: true, id: "z", name: "Same", score: 2 },
    { active: true, id: "a", name: "Same", score: 2 },
    { active: true, id: "empty", name: "Empty", score: null },
  ];
  const ascending = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "asc", fieldKey: "score" }],
    }),
    rows,
  });
  const descending = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "desc", fieldKey: "score" }],
    }),
    rows,
  });
  const inputOrder = applySystemCollectionQuery({
    descriptor: descriptor({ query: {} }),
    query: query(),
    rows,
  });

  expect(ascending.rows.map((row) => row.id)).toEqual(["a", "z", "empty"]);
  expect(descending.rows.map((row) => row.id)).toEqual(["a", "z", "empty"]);
  expect(inputOrder.rows.map((row) => row.id)).toEqual(["z", "a", "empty"]);
});

test("boolean property queries treat missing and null as false without coercing conflicts", () => {
  const rows = [
    { active: true, enabled: true, id: "true", name: "True" },
    { active: true, enabled: false, id: "false", name: "False" },
    { active: true, id: "missing", name: "Missing" },
    { active: true, enabled: null, id: "null", name: "Null" },
    { active: true, enabled: "false", id: "invalid", name: "Invalid" },
  ];
  const falseRows = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ fieldKey: "enabled", operator: "eq", value: false }],
      sort: [{ direction: "asc", fieldKey: "name" }],
    }),
    rows,
  });
  const notTrueRows = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ fieldKey: "enabled", operator: "neq", value: true }],
      sort: [{ direction: "asc", fieldKey: "name" }],
    }),
    rows,
  });
  const ascending = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "asc", fieldKey: "enabled" }],
    }),
    rows,
  });
  const descending = applySystemCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "desc", fieldKey: "enabled" }],
    }),
    rows,
  });

  expect(falseRows.rows.map((row) => row.id)).toEqual([
    "false",
    "missing",
    "null",
  ]);
  expect(notTrueRows.rows.map((row) => row.id)).toEqual([
    "false",
    "missing",
    "null",
  ]);
  expect(ascending.rows.map((row) => row.id)).toEqual([
    "false",
    "missing",
    "null",
    "true",
    "invalid",
  ]);
  expect(descending.rows.map((row) => row.id)).toEqual([
    "true",
    "false",
    "missing",
    "null",
    "invalid",
  ]);
});

test("validator drops descriptor-stale capabilities and rejects incomplete custom rules", () => {
  const customField: SystemCollectionFieldDescriptor<TestRow> = {
    filter: {
      kind: "custom",
      matches: (row, rule) => row.name === rule.value,
      operators: ["same"],
      renderEditor: () => null,
      validate: (rule) => typeof rule.value === "string",
    },
    getValue: (row) => row.name,
    key: "custom",
    label: "Custom",
    valueSemantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const result = validateSystemCollectionQuery(
    descriptor({
      fields: [customField],
      query: {},
    }),
    query({
      filters: [
        { fieldKey: "custom", operator: "same", value: 42 },
        { fieldKey: "missing", operator: "eq", value: "x" },
      ],
      search: "stale",
      sort: [{ direction: "asc", fieldKey: "custom" }],
    }),
  );

  expect(result.query).toEqual(query());
  expect(result.reset).toBe(true);
  expect(result.issues.map((issue) => issue.reason)).toEqual([
    "search-unavailable",
    "invalid-value",
    "unknown-field",
    "unsupported-sort",
  ]);
});
