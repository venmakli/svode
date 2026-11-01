import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  defineSchemaBackedCollectionProperty,
  type CollectionPropertyDefinition,
} from "./collection-property";
import {
  compareStandardPropertyValues,
  matchesStandardPropertyFilter,
  validateStandardPropertyFilterRule,
} from "./standard-query";
import type { Column } from "./types";

// The same fixtures run against the Page Collection engine of svode-core
// (crates/svode-core/tests/collection_query_conformance.rs).
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../fixtures/collection-query-conformance.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { suites: Suite[] };

interface Suite {
  name: string;
  columns: Column[];
  items: Item[];
  filters: {
    name: string;
    filter: FixtureFilter[];
    invalid?: boolean;
    expect?: string[];
  }[];
  sorts: {
    name: string;
    sort: { field: string; desc?: boolean }[];
    expect: string[];
  }[];
}

interface FixtureFilter {
  field: string;
  op: string;
  value?: unknown;
  values?: unknown[];
}

interface Item {
  id: string;
  title: string;
  description?: string;
  fields: Record<string, unknown>;
}

function suiteProperties(suite: Suite) {
  const system: Column[] = [
    { name: "title", type: "text" },
    { name: "description", type: "text" },
  ];
  return new Map<string, CollectionPropertyDefinition<Item>>(
    [...system, ...suite.columns].map((column) => [
      column.name,
      defineSchemaBackedCollectionProperty<Item>({
        capabilities: {
          filter: { kind: "standard" },
          sort: { kind: "standard" },
        },
        column,
        getValue: (item) =>
          column.name === "title"
            ? item.title
            : column.name === "description"
              ? item.description
              : item.fields[column.name],
      }),
    ]),
  );
}

for (const suite of fixtures.suites) {
  const properties = suiteProperties(suite);
  const property = (field: string) => {
    const found = properties.get(field);
    if (!found) throw new Error(`${suite.name}: unknown field ${field}`);
    return found;
  };

  for (const filterCase of suite.filters) {
    test(`query conformance: ${suite.name} / ${filterCase.name}`, () => {
      const rules = filterCase.filter.map((filter) => ({
        property: property(filter.field),
        rule: {
          operator: filter.op,
          value: filter.value,
          values: filter.values,
        },
      }));
      const valid = rules.every(({ property, rule }) =>
        validateStandardPropertyFilterRule(property, rule),
      );
      if (filterCase.invalid) {
        expect(valid).toBe(false);
        return;
      }
      expect(valid).toBe(true);
      const ids = suite.items
        .filter((item) =>
          rules.every(({ property, rule }) =>
            matchesStandardPropertyFilter(property, item, rule),
          ),
        )
        .map((item) => item.id)
        .sort();
      expect(ids).toEqual([...(filterCase.expect ?? [])].sort());
    });
  }

  for (const sortCase of suite.sorts) {
    test(`query conformance: ${suite.name} / ${sortCase.name}`, () => {
      const ids = [...suite.items]
        .sort((left, right) => {
          for (const key of sortCase.sort) {
            const keyProperty = property(key.field);
            const compared = compareStandardPropertyValues(
              keyProperty,
              keyProperty.getValue(left),
              keyProperty.getValue(right),
              key.desc ? "desc" : "asc",
            );
            if (compared !== 0) return compared;
          }
          return 0;
        })
        .map((item) => item.id);
      expect(ids).toEqual(sortCase.expect);
    });
  }
}
