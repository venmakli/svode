import { expect, test } from "bun:test";
import { PROPERTY_TYPES } from "../lib/utils";
import {
  newPropertyColumn,
  PROPERTY_TYPE_ICONS,
  propertyTypeLabel,
  propertyTypeSettingsMeta,
} from "./property-type-meta";

test("canonical property type metadata covers every supported type", () => {
  const types = PROPERTY_TYPES.map((item) => item.value);

  expect(Object.keys(PROPERTY_TYPE_ICONS)).toEqual(types);
  for (const type of types) {
    expect(Boolean(PROPERTY_TYPE_ICONS[type])).toBe(true);
    expect(propertyTypeLabel(type).length > 0).toBe(true);
  }
});

test("type settings metadata stays context neutral", () => {
  expect(
    Boolean(propertyTypeSettingsMeta({ name: "Done", type: "boolean" })?.label),
  ).toBe(true);
  expect(
    Boolean(
      propertyTypeSettingsMeta({ name: "Tags", type: "multi_select" })?.label,
    ),
  ).toBe(true);
  expect(propertyTypeSettingsMeta({ name: "Notes", type: "text" })).toBeNull();
});

test("a new property is named after its type and numbered when the name is taken", () => {
  const text = propertyTypeLabel("text");
  const columns = [
    { name: text, type: "text" as const },
    { name: `${text} 2`, type: "text" as const },
  ];

  expect(
    newPropertyColumn({ columns: [], type: "text", collectionPath: "tasks" }),
  ).toEqual({
    name: text,
    type: "text",
  });
  expect(
    newPropertyColumn({ columns, type: "text", collectionPath: "tasks" }).name,
  ).toBe(`${text} 3`);
  expect(
    newPropertyColumn({ columns, type: "relation", collectionPath: "tasks" }),
  ).toEqual({
    name: propertyTypeLabel("relation"),
    type: "relation",
    relation: "tasks",
  });
  expect(
    newPropertyColumn({ columns, type: "relation", collectionPath: "" })
      .relation,
  ).toBe(".");
});
