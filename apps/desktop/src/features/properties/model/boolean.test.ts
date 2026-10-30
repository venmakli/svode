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

test("effectiveBooleanDisplay draws a missing or newer display as checkbox", () => {
  expect(effectiveBooleanDisplay(undefined)).toBe("checkbox");
  expect(effectiveBooleanDisplay(null)).toBe("checkbox");
  expect(effectiveBooleanDisplay("checkbox")).toBe("checkbox");
  expect(effectiveBooleanDisplay("switch")).toBe("switch");
  expect(effectiveBooleanDisplay("toggle")).toBe("checkbox");
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
