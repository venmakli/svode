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

interface Item {
  id: string;
  priority: string;
  score: number;
  source: string;
  title: string;
}

const item: Item = {
  id: "item:one",
  priority: "High",
  score: 42,
  source: "codex",
  title: "Review",
};

test("Collection Properties preserve explicit ownership across all supported origins", () => {
  const schemaBacked = defineSchemaBackedCollectionProperty<Item>({
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
  const ownerDefined: CollectionPropertyDefinition<Item> = {
    capabilities: { sort: { kind: "standard" } },
    getValue: (item) => item.title,
    key: "title",
    label: "Title",
    origin: "owner_defined",
    owner: { featureId: "fixture", kind: "feature" },
    semantics: { kind: "standard", standard: { type: "text" } },
  };
  const computed: CollectionPropertyDefinition<Item> = {
    capabilities: { sort: { kind: "standard" } },
    getValue: (item) => item.score,
    key: "score",
    label: "Score",
    origin: "computed",
    owner: { featureId: "fixture", kind: "feature" },
    semantics: { kind: "standard", standard: { type: "number" } },
  };
  const domainSpecific: CollectionPropertyDefinition<Item> = {
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
  const presentation = defineCollectionPresentation<Item>({
    descriptor: {
      getItemId: (item) => item.id,
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
    state: { phase: "ready", items: [item] },
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
        getItemId: (item) => item.id,
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
      items: [item],
    }).items,
  ).toEqual([item]);
  expect(
    (presentation as unknown as { diagnostics: readonly unknown[] })
      .diagnostics,
  ).toEqual([]);
});

test("an owner display draws a standard value while its filter stays standard", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CollectionPropertyValue } =
    await import("../ui/collection-property-value");
  const { defineComputedCollectionProperty } =
    await import("./collection-property");
  const property = defineComputedCollectionProperty<Item>({
    capabilities: { filter: { kind: "standard" } },
    display: {
      render: (value) => <b>{String(value)} icon</b>,
      renderDetail: (value) => <i>{String(value)} with name</i>,
    },
    featureId: "agents",
    getValue: (current) => [current.source],
    key: "providers",
    label: "Providers",
    standard: { options: [{ name: "codex" }], type: "multi_select" },
  });

  expect(resolveStandardPropertyColumn(property)?.type).toBe("multi_select");
  expect(
    renderToStaticMarkup(
      <CollectionPropertyValue
        property={property as CollectionPropertyDefinition<unknown>}
        item={item}
      />,
    ),
  ).toBe("<b>codex icon</b>");
  expect(
    renderToStaticMarkup(
      <CollectionPropertyValue
        context="detail"
        property={property as CollectionPropertyDefinition<unknown>}
        item={item}
      />,
    ),
  ).toBe("<i>codex with name</i>");
  const presentation = defineCollectionPresentation<Item>({
    descriptor: {
      getItemId: (current) => current.id,
      id: "all",
      label: "All",
      layout: {
        getTitle: (current) => current.title,
        kind: "list",
        visibleProperties: ["providers"],
      },
      properties: [property],
      query: {},
    },
    state: { phase: "ready", items: [item] },
  });
  const descriptor = (
    presentation as unknown as {
      instance: {
        descriptor: Parameters<
          typeof applyCollectionQuery<Item>
        >[0]["descriptor"];
      };
    }
  ).instance.descriptor;
  expect(
    applyCollectionQuery({
      descriptor,
      query: {
        filters: [
          { operator: "contains", propertyKey: "providers", value: "codex" },
        ],
        search: "",
        sort: [],
      },
      items: [item],
    }).items,
  ).toEqual([item]);
});
