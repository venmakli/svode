import { expect, test } from "bun:test";

import { readCollectionPresentationRuntime } from "../runtime/model/runtime";
import { defineCollectionPresentation } from "../runtime/model/runtime";
import { definePageCollection } from "./page-collection-definition";

test("Page Collection normalizes one Property set for all five presentations", () => {
  const definition = definePageCollection({
    collectionPath: "Projects/tasks.collection",
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
