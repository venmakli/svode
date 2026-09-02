import { expect, test } from "bun:test";

import { readCollectionPresentationRuntime } from "../runtime/model/runtime";
import { defineCollectionPresentation } from "../runtime/model/runtime";
import {
  activatePageCollectionItem,
  definePageCollection,
} from "./page-collection-definition";

test("Page Collection shares Properties and descriptor activation across all five presentations", () => {
  const activations: string[] = [];
  const definition = definePageCollection({
    collectionPath: "Projects/tasks.collection",
    onActivate: (page, context) => {
      activations.push(`${context.rowId}:${page.path}`);
    },
    schema: {
      columns: [
        {
          name: "Status",
          options: [{ name: "Todo" }, { name: "Done" }],
          type: "select",
        },
        { name: "Due", type: "date" },
        { display: "bytes", name: "Size", type: "number" },
      ],
      views: [],
    },
    views: [
      {
        name: "Table",
        type: "table",
        visible_fields: ["title", "Status", "Due", "Size"],
      },
      {
        card_fields: ["title", "Due"],
        group_by: "Status",
        name: "Board",
        type: "board",
      },
      {
        card_fields: ["title", "Status"],
        date_field: "Due",
        name: "Calendar",
        type: "calendar",
      },
      { card_fields: ["title", "Status"], name: "List", type: "list" },
      { card_fields: ["title", "Size"], name: "Gallery", type: "gallery" },
    ],
  });

  expect(definition.presentations.map((item) => item.layout.kind)).toEqual([
    "table",
    "board",
    "calendar",
    "list",
    "gallery",
  ]);
  expect(
    definition.presentations.every(
      (presentation) => presentation.properties === definition.properties,
    ),
  ).toBe(true);
  for (const presentation of definition.presentations) {
    presentation.onActivate(pageFixture, {
      rowId: presentation.getRowId(pageFixture),
    });
  }
  expect(activations).toEqual(
    Array.from(
      { length: 5 },
      () => "Projects/tasks.collection/one.md:Projects/tasks.collection/one.md",
    ),
  );
  expect(definition.properties.map(({ key, origin }) => [key, origin])).toEqual(
    [
      ["title", "owner_defined"],
      ["created", "computed"],
      ["updated", "computed"],
      ["Status", "schema_backed"],
      ["Due", "schema_backed"],
      ["Size", "schema_backed"],
    ],
  );
  expect(definition.presentations[0]?.layout).toEqual({
    density: "comfortable",
    kind: "table",
    primaryProperty: "title",
    visibleProperties: ["title", "Status", "Due", "Size"],
  });
  expect(
    definition.presentations.map(
      (descriptor) =>
        readCollectionPresentationRuntime(
          defineCollectionPresentation({
            descriptor,
            state: { phase: "ready", rows: [] },
          }),
        ).diagnostics,
    ),
  ).toEqual([[], [], [], [], []]);
});

test("Page Collection activation failure stays inside the interaction boundary", async () => {
  const definition = definePageCollection({
    collectionPath: "Projects/tasks.collection",
    onActivate: async () => {
      throw new Error("Peek unavailable");
    },
    schema: { columns: [], views: [] },
    views: [{ name: "Table", type: "table", visible_fields: ["title"] }],
  });

  const result = await activatePageCollectionItem(
    definition.presentations[0]!,
    pageFixture,
  );

  expect(result).toEqual({ message: "Peek unavailable", ok: false });
});

const pageFixture = {
  body: "",
  meta: {
    created: "",
    extra: {},
    icon: null,
    title: "One",
    updated: "",
  },
  path: "Projects/tasks.collection/one.md",
};
