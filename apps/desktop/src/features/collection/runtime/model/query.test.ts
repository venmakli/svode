import { expect, test } from "bun:test";

import {
  applyCollectionQuery,
  normalizeCollectionSearchText,
  validateCollectionQuery,
} from "./query";
import type {
  CollectionPropertyDefinition,
  CollectionStandardPropertySemantics,
} from "@/features/properties";
import type {
  CollectionPresentationDescriptor,
  CollectionQueryState,
} from "./types";

interface TestItem {
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
  getValue: (item: TestItem) => unknown,
): CollectionPropertyDefinition<TestItem> {
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

const properties: readonly CollectionPropertyDefinition<TestItem>[] = [
  standardProperty("enabled", { type: "boolean" }, (item) => item.enabled),
  standardProperty("name", { type: "text" }, (item) => item.name),
  standardProperty("score", { type: "number" }, (item) => item.score),
  standardProperty("priority", prioritySemantics, (item) => item.priority),
  standardProperty(
    "tags",
    {
      options: [{ name: "Bug" }, { name: "Feature" }],
      type: "multi_select",
    },
    (item) => item.tags,
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
    (item) => item.status,
  ),
  standardProperty("due", { type: "date" }, (item) => item.due),
];

function descriptor(
  overrides: Partial<CollectionPresentationDescriptor<TestItem>> = {},
): CollectionPresentationDescriptor<TestItem> {
  return {
    properties,
    getItemId: (item) => item.id,
    id: "people",
    label: "People",
    layout: {
      getTitle: (item) => item.name,
      kind: "list",
      visibleProperties: [],
    },
    query: {
      fixedPredicate: (item) => item.active,
      getSearchText: (item) => item.name,
    },
    ...overrides,
  };
}

function query(
  overrides: Partial<CollectionQueryState> = {},
): CollectionQueryState {
  return { filters: [], search: "", sort: [], ...overrides };
}

test("search normalization is deterministic Unicode NFKC whitespace substring matching", () => {
  expect(normalizeCollectionSearchText("  Ａlpha\t  TASK  ")).toBe(
    "alpha task",
  );

  const result = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({ search: " alpha   task " }),
    items: [
      {
        active: true,
        id: "fullwidth",
        name: "Ａlpha Task",
      },
      { active: true, id: "other", name: "Beta" },
    ],
  });

  expect(result.items.map((item) => item.id)).toEqual(["fullwidth"]);
});

test("pipeline applies fixed predicate, search, AND filters, then explicit sort", () => {
  const result = applyCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", propertyKey: "score" }],
        fixedPredicate: (item) => item.active,
        getSearchText: (item) => item.name,
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
    items: [
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

  expect(result.sourceItems.map((item) => item.id)).toEqual([
    "z",
    "a",
    "filtered",
  ]);
  expect(result.items.map((item) => item.id)).toEqual(["a", "z"]);
});

test("default property sort and defaultCompare apply only without explicit user sort", () => {
  const items = [
    { active: true, id: "b", name: "Beta", score: 2 },
    { active: true, id: "a", name: "Alpha", score: 1 },
  ];
  const defaultField = applyCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", propertyKey: "score" }],
      },
    }),
    query: query(),
    items,
  });
  const userSort = applyCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultSort: [{ direction: "desc", propertyKey: "score" }],
      },
    }),
    query: query({
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    items,
  });
  const defaultCompare = applyCollectionQuery({
    descriptor: descriptor({
      query: {
        defaultCompare: (left, right) => left.score! - right.score!,
      },
    }),
    query: query(),
    items,
  });

  expect(defaultField.items.map((item) => item.id)).toEqual(["b", "a"]);
  expect(userSort.items.map((item) => item.id)).toEqual(["a", "b"]);
  expect(defaultCompare.items.map((item) => item.id)).toEqual(["a", "b"]);
});

test("Property semantics match Collection option, group, multi-value, and date fixtures", () => {
  const items: TestItem[] = [
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
  const filtered = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [
        { propertyKey: "status", operator: "group_eq", value: "in_progress" },
        { propertyKey: "tags", operator: "contains", value: "Feature" },
      ],
      sort: [{ direction: "asc", propertyKey: "priority" }],
    }),
    items,
  });
  const dateEquals = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ propertyKey: "due", operator: "eq", value: "2026-01-15" }],
    }),
    items,
  });
  const dateBefore = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [
        { propertyKey: "due", operator: "before", value: "2026-01-06" },
      ],
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    items,
  });

  expect(filtered.items.map((item) => item.id)).toEqual(["b", "a", "c", "d"]);
  expect(dateEquals.items.map((item) => item.id)).toEqual(["a"]);
  expect(dateBefore.items.map((item) => item.id)).toEqual(["b", "e"]);
});

test("Property semantics reject backend-invalid payloads and never match null as zero", () => {
  const invalidSortField: CollectionPropertyDefinition<TestItem> = {
    capabilities: { sort: { kind: "standard" } },
    getValue: (item) => item.name,
    key: "invalid-sort",
    label: "Invalid sort",
    origin: "domain_specific",
    owner: { featureId: "query-test", kind: "feature" },
    semantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const invalid = validateCollectionQuery(
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
  const zero = applyCollectionQuery({
    descriptor: descriptor({ query: {} }),
    query: query({
      filters: [{ propertyKey: "score", operator: "eq", value: 0 }],
    }),
    items: [
      { active: true, id: "null", name: "Null", score: null },
      { active: true, id: "zero", name: "Zero", score: 0 },
    ],
  });
  const emptyText = validateCollectionQuery(
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
  expect(zero.items.map((item) => item.id)).toEqual(["zero"]);
  expect(emptyText.reset).toBe(false);
});

test("property sort keeps empty values last in both directions and uses item id ties", () => {
  const items = [
    { active: true, id: "z", name: "Same", score: 2 },
    { active: true, id: "a", name: "Same", score: 2 },
    { active: true, id: "empty", name: "Empty", score: null },
  ];
  const ascending = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "asc", propertyKey: "score" }],
    }),
    items,
  });
  const descending = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "desc", propertyKey: "score" }],
    }),
    items,
  });
  const inputOrder = applyCollectionQuery({
    descriptor: descriptor({ query: {} }),
    query: query(),
    items,
  });

  expect(ascending.items.map((item) => item.id)).toEqual(["a", "z", "empty"]);
  expect(descending.items.map((item) => item.id)).toEqual(["a", "z", "empty"]);
  expect(inputOrder.items.map((item) => item.id)).toEqual(["z", "a", "empty"]);
});

test("boolean property queries treat missing and null as false without coercing conflicts", () => {
  const items = [
    { active: true, enabled: true, id: "true", name: "True" },
    { active: true, enabled: false, id: "false", name: "False" },
    { active: true, id: "missing", name: "Missing" },
    { active: true, enabled: null, id: "null", name: "Null" },
    { active: true, enabled: "false", id: "invalid", name: "Invalid" },
  ];
  const falseItems = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ propertyKey: "enabled", operator: "eq", value: false }],
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    items,
  });
  const notTrueItems = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      filters: [{ propertyKey: "enabled", operator: "neq", value: true }],
      sort: [{ direction: "asc", propertyKey: "name" }],
    }),
    items,
  });
  const ascending = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "asc", propertyKey: "enabled" }],
    }),
    items,
  });
  const descending = applyCollectionQuery({
    descriptor: descriptor(),
    query: query({
      sort: [{ direction: "desc", propertyKey: "enabled" }],
    }),
    items,
  });

  expect(falseItems.items.map((item) => item.id)).toEqual([
    "false",
    "missing",
    "null",
  ]);
  expect(notTrueItems.items.map((item) => item.id)).toEqual([
    "false",
    "missing",
    "null",
  ]);
  expect(ascending.items.map((item) => item.id)).toEqual([
    "false",
    "missing",
    "null",
    "true",
    "invalid",
  ]);
  expect(descending.items.map((item) => item.id)).toEqual([
    "true",
    "false",
    "missing",
    "null",
    "invalid",
  ]);
});

test("validator drops descriptor-stale capabilities and rejects incomplete custom rules", () => {
  const customField: CollectionPropertyDefinition<TestItem> = {
    capabilities: {
      filter: {
        kind: "custom",
        matches: (item, rule) => item.name === rule.value,
        operators: ["same"],
        renderEditor: () => null,
        validate: (rule) => typeof rule.value === "string",
      },
    },
    getValue: (item) => item.name,
    key: "custom",
    label: "Custom",
    origin: "domain_specific",
    owner: { featureId: "query-test", kind: "feature" },
    semantics: {
      kind: "custom",
      render: (value) => String(value),
    },
  };
  const result = validateCollectionQuery(
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
