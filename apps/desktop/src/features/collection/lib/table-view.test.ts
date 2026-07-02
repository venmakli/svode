import { expect, test } from "bun:test";
import type { CollectionView } from "@/features/collection/query/model";
import type { CollectionSchema } from "@/features/properties";
import { normalizeVisibleFields } from "./table-view";

test("table visible fields preserve icon as a title-prefix setting", () => {
  const view = {
    name: "Table",
    type: "table",
    visible_fields: ["icon", "title", "Status"],
  } satisfies CollectionView;
  const schema: CollectionSchema = {
    columns: [{ name: "Status", type: "status" }],
  };

  expect(normalizeVisibleFields(view, schema)).toEqual([
    "icon",
    "title",
    "Status",
  ]);
});
