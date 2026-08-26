import { expect, test } from "bun:test";
import { PROPERTY_TYPES } from "../lib/utils";
import {
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
