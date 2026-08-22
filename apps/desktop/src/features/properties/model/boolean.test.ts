import { expect, test } from "bun:test";

import { effectiveBooleanDisplay, effectiveBooleanValue } from "./boolean";
import { validatePropertyValue } from "./validation";
import type { Column } from "./types";

const column: Column = { name: "Active", type: "boolean" };

test("effectiveBooleanValue keeps exactly two states without truthy coercion", () => {
  expect(effectiveBooleanValue(true)).toBe(true);
  expect(effectiveBooleanValue(false)).toBe(false);
  expect(effectiveBooleanValue(null)).toBe(false);
  expect(effectiveBooleanValue(undefined)).toBe(false);
  expect(effectiveBooleanValue("false")).toBe(undefined);
  expect(effectiveBooleanValue(1)).toBe(undefined);
});

test("effectiveBooleanDisplay defaults only missing display to checkbox", () => {
  expect(effectiveBooleanDisplay(undefined)).toBe("checkbox");
  expect(effectiveBooleanDisplay(null)).toBe("checkbox");
  expect(effectiveBooleanDisplay("checkbox")).toBe("checkbox");
  expect(effectiveBooleanDisplay("switch")).toBe("switch");
  let error: unknown;
  try {
    effectiveBooleanDisplay("ring");
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toBe("Error: Invalid boolean display: ring");
});

test("boolean validation accepts missing but preserves non-boolean conflicts", () => {
  expect(validatePropertyValue(column, true)).toEqual({ invalid: false });
  expect(validatePropertyValue(column, false)).toEqual({ invalid: false });
  expect(validatePropertyValue(column, null)).toEqual({ invalid: false });
  expect(validatePropertyValue(column, undefined)).toEqual({ invalid: false });
  expect(validatePropertyValue(column, "false")).toEqual({
    code: "type_conflict",
    invalid: true,
  });
});
