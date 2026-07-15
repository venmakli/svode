import { expect, test } from "bun:test";
import { physicalToLogicalPoint } from "./file-drop";

test("converts physical file-drop coordinates to logical coordinates", () => {
  expect(physicalToLogicalPoint({ x: 450, y: 225 }, 1.5)).toEqual({
    x: 300,
    y: 150,
  });
});

test("uses a safe scale for invalid scale factors", () => {
  expect(physicalToLogicalPoint({ x: 40, y: 20 }, 0)).toEqual({
    x: 40,
    y: 20,
  });
});
