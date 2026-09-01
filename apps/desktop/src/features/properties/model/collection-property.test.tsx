import { expect, test } from "bun:test";

import {
  applyCollectionQuery,
  defineCollectionPresentation,
} from "@/features/collection";

import {
  defineSchemaBackedCollectionProperty,
  resolveStandardPropertyColumn,
  type CollectionPropertyDefinition,
} from "./collection-property";

interface Row {
  id: string;
  priority: string;
  score: number;
  source: string;
  title: string;
}

const row: Row = {
  id: "entry:one",
  priority: "High",
  score: 42,
  source: "codex",
  title: "Review",
};

test("Collection Properties preserve explicit ownership across all supported origins", () => {
  const schemaBacked = defineSchemaBackedCollectionProperty<Row>({
    capabilities: {
      filter: { kind: "standard" },
      sort: { kind: "standard" },
    },
    column: {
      name: "priority",
      options: [{ name: "Low" }, { name: "High" }],
      type: "select",
    },
    getValue: (item) => item.priority,
  });
  const ownerDefined: CollectionPropertyDefinition<Row> = {
    capabilities: { sort: { kind: "standard" } },
    getValue: (item) => item.title,
    key: "title",
    label: "Title",
    origin: "owner_defined",
    owner: { featureId: "fixture", kind: "feature" },
    semantics: { kind: "standard", standard: { type: "text" } },
  };
  const computed: CollectionPropertyDefinition<Row> = {
    capabilities: { sort: { kind: "standard" } },
    getValue: (item) => item.score,
    key: "score",
    label: "Score",
    origin: "computed",
    owner: { featureId: "fixture", kind: "feature" },
    semantics: { kind: "standard", standard: { type: "number" } },
  };
  const domainSpecific: CollectionPropertyDefinition<Row> = {
    getValue: (item) => item.source,
    key: "source",
    label: "Source",
    origin: "domain_specific",
    owner: { featureId: "fixture", kind: "feature" },
    semantics: { kind: "custom", render: (value) => String(value) },
  };
  const properties = [
    schemaBacked,
    ownerDefined,
    computed,
    domainSpecific,
  ] as const;
  const presentation = defineCollectionPresentation<Row>({
    descriptor: {
      getRowId: (item) => item.id,
      id: "origin-fixture",
      label: "Origin fixture",
      layout: {
        getTitle: (item) => item.title,
        kind: "list",
        visibleProperties: properties.map((property) => property.key),
      },
      properties,
      query: {},
    },
    state: { phase: "ready", rows: [row] },
  });

  expect(properties.map((property) => property.origin)).toEqual([
    "schema_backed",
    "owner_defined",
    "computed",
    "domain_specific",
  ]);
  expect(resolveStandardPropertyColumn(schemaBacked)).toEqual({
    name: "priority",
    options: [{ name: "Low" }, { name: "High" }],
    type: "select",
  });
  expect(resolveStandardPropertyColumn(ownerDefined)).toEqual({
    name: "title",
    type: "text",
  });
  expect(resolveStandardPropertyColumn(domainSpecific)).toBeNull();
  expect(
    applyCollectionQuery({
      descriptor: {
        getRowId: (item) => item.id,
        id: "origin-fixture",
        label: "Origin fixture",
        layout: {
          getTitle: (item) => item.title,
          kind: "list",
          visibleProperties: [],
        },
        properties,
        query: {},
      },
      query: {
        filters: [{ operator: "eq", propertyKey: "priority", value: "High" }],
        search: "",
        sort: [],
      },
      rows: [row],
    }).rows,
  ).toEqual([row]);
  expect(
    (presentation as unknown as { diagnostics: readonly unknown[] })
      .diagnostics,
  ).toEqual([]);
});
