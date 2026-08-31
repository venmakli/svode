import { expect, test } from "bun:test";

import {
  applyCollectionCoreQuery,
  normalizeCollectionCoreSearchText,
  validateCollectionCoreQuery,
} from "./query";
import type {
  CollectionPropertyDefinition,
  CollectionStandardPropertySemantics,
} from "@/features/properties";
import type {
  CollectionCorePresentationDescriptor,
  CollectionCoreQueryState,
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

const prioritySemantics = {
  options: [{ name: "Low" }, { name: "High" }],
  type: "select" as const,
};

function standardProperty(
  key: string,
  standard: CollectionStandardPropertySemantics,
  getValue: (row: TestRow) => unknown,
): CollectionPropertyDefinition<TestRow> {
  return {
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    getValue,
    key,
    label: key,
    origin: "owner_defined",
    owner: { featureId: "query-test", kind: "feature" },
    semantics: { kind: "standard", standard },
  };
}

const properties: readonly CollectionPropertyDefinition<TestRow>[] = [
  standardProperty("enabled", { type: "boolean" }, (row) => row.enabled),
  standardProperty("name", { type: "text" }, (row) => row.name),
  standardProperty("score", { type: "number" }, (row) => row.score),
  standardProperty("priority", prioritySemantics, (row) => row.priority),
  standardProperty(
    "tags",
    {
      options: [{ name: "Bug" }, { name: "Feature" }],
      type: "multi_select",
    },
    (row) => row.tags,
  ),
  standardProperty(
    "status",
    {
      options: [
        { group: "todo", name: "Todo" },
        { group: "in_progress", name: "Doing" },
        { group: "done", name: "Done" },
      ],
      type: "status",
    },
    (row) => row.status,
  ),
  standardProperty("due", { type: "date" }, (row) => row.due),
];

function descriptor(
  overrides: Partial<CollectionCorePresentationDescriptor<TestRow>> = {},
): CollectionCorePresentationDescriptor<TestRow> {
  return {
    properties,
    getRowId: (row) => row.id,
    id: "people",
    label: "People",
    layout: {
      getTitle: (row) => row.name,
      kind: "list",
      visibleProperties: [],
    },
    query: {
      fixedPredicate: (row) => row.active,
      getSearchText: (row) => row.name,
    },
    ...overrides,
  };
}

function query(
  overrides: Partial<CollectionCoreQueryState> = {},
): CollectionCoreQueryState {
  return { filters: [], search: "", sort: [], ...overrides };
}

test("search normalization is deterministic Unicode NFKC whitespace substring matching", () => {
  expect(normalizeCollectionCoreSearchText("  Ａlpha\t  TASK  ")).toBe(
    "alpha task",
  );

  const result = applyCollectionCoreQuery({
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
  const result = applyCollectionCoreQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", propertyKey: "score" }],
        fixedPredicate: (row) => row.active,
        getSearchText: (row) => row.name,
      },
    }),
    query: query({
      filters: [
        { propertyKey: "score", operator: "gte", value: 2 },
        { propertyKey: "tags", operator: "contains", value: "Feature" },
      ],
      search: "task",
      sort: [{ direction: "asc", propertyKey: "name" }],
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

test("default property sort and defaultCompare apply only without explicit user sort", () => {
  const rows = [
    { active: true, id: "b", name: "Beta", score: 2 },
    { active: true, id: "a", name: "Alpha", score: 1 },
  ];
  const defaultField = applyCollectionCoreQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", propertyKey: "score" }],
      },
    }),
    query: query(),
    rows,
  });
  const userSort = applyCollectionCoreQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", propertyKey: "score" }],
      },
    }),
    query: query({
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    rows,
  });
  const defaultCompare = applyCollectionCoreQuery({
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
  const filtered = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      filters: [
        { propertyKey: "status", operator: "group_eq", value: "in_progress" },
        { propertyKey: "tags", operator: "contains", value: "Feature" },
      ],
      sort: [{ direction: "asc", propertyKey: "priority" }],
    }),
    rows,
  });
  const dateEquals = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ propertyKey: "due", operator: "eq", value: "2026-01-15" }],
    }),
    rows,
  });
  const dateBefore = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      filters: [
        { propertyKey: "due", operator: "before", value: "2026-01-06" },
      ],
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    rows,
  });

  expect(filtered.rows.map((row) => row.id)).toEqual(["b", "a", "c", "d"]);
  expect(dateEquals.rows.map((row) => row.id)).toEqual(["a"]);
  expect(dateBefore.rows.map((row) => row.id)).toEqual(["b", "e"]);
});

test("property adapters reject backend-invalid payloads and never match null as zero", () => {
  const invalidSortField: CollectionPropertyDefinition<TestRow> = {
    capabilities: { sort: { kind: "standard" } },
    getValue: (row) => row.name,
    key: "invalid-sort",
    label: "Invalid sort",
    origin: "domain_specific",
    owner: { featureId: "query-test", kind: "feature" },
    semantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const invalid = validateCollectionCoreQuery(
    descriptor({ properties: [...properties, invalidSortField] }),
    query({
      filters: [
        { propertyKey: "score", operator: "eq", values: [1, 2] },
        { propertyKey: "score", operator: "eq", value: "2" },
        { propertyKey: "name", operator: "is_empty", value: "unexpected" },
        { propertyKey: "due", operator: "eq", value: "2026-02-31" },
        {
          propertyKey: "due",
          operator: "eq",
          value: "@today+9223372036854775808",
        },
        { propertyKey: "priority", operator: "eq", value: "Unknown" },
      ],
      sort: [{ direction: "asc", propertyKey: "invalid-sort" }],
    }),
  );
  const zero = applyCollectionCoreQuery({
    descriptor: descriptor({ query: {} }),
    query: query({
      filters: [{ propertyKey: "score", operator: "eq", value: 0 }],
    }),
    rows: [
      { active: true, id: "null", name: "Null", score: null },
      { active: true, id: "zero", name: "Zero", score: 0 },
    ],
  });
  const emptyText = validateCollectionCoreQuery(
    descriptor(),
    query({
      filters: [{ propertyKey: "name", operator: "eq", value: "" }],
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

test("property sort keeps empty values last in both directions and uses rowId ties", () => {
  const rows = [
    { active: true, id: "z", name: "Same", score: 2 },
    { active: true, id: "a", name: "Same", score: 2 },
    { active: true, id: "empty", name: "Empty", score: null },
  ];
  const ascending = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "asc", propertyKey: "score" }],
    }),
    rows,
  });
  const descending = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "desc", propertyKey: "score" }],
    }),
    rows,
  });
  const inputOrder = applyCollectionCoreQuery({
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
  const falseRows = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ propertyKey: "enabled", operator: "eq", value: false }],
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    rows,
  });
  const notTrueRows = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ propertyKey: "enabled", operator: "neq", value: true }],
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    rows,
  });
  const ascending = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "asc", propertyKey: "enabled" }],
    }),
    rows,
  });
  const descending = applyCollectionCoreQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "desc", propertyKey: "enabled" }],
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
  const customField: CollectionPropertyDefinition<TestRow> = {
    capabilities: {
      filter: {
        kind: "custom",
        matches: (row, rule) => row.name === rule.value,
        operators: ["same"],
        renderEditor: () => null,
        validate: (rule) => typeof rule.value === "string",
      },
    },
    getValue: (row) => row.name,
    key: "custom",
    label: "Custom",
    origin: "domain_specific",
    owner: { featureId: "query-test", kind: "feature" },
    semantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const result = validateCollectionCoreQuery(
    descriptor({
      properties: [customField],
      query: {},
    }),
    query({
      filters: [
        { propertyKey: "custom", operator: "same", value: 42 },
        { propertyKey: "missing", operator: "eq", value: "x" },
      ],
      search: "stale",
      sort: [{ direction: "asc", propertyKey: "custom" }],
    }),
  );

  expect(result.query).toEqual(query());
  expect(result.reset).toBe(true);
  expect(result.issues.map((issue) => issue.reason)).toEqual([
    "search-unavailable",
    "invalid-value",
    "unknown-property",
    "unsupported-sort",
  ]);
});
