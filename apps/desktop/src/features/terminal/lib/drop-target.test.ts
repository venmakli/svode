import { expect, test } from "bun:test";
import {
  EMPTY_NATIVE_DROP_TARGET_STATE,
  isPointInsideDropTarget,
  reduceNativeDropTarget,
} from "./drop-target";

const leftSurface = { left: 0, top: 0, right: 200, bottom: 300 };
const rightSurface = { left: 220, top: 0, right: 420, bottom: 300 };

test("selects only the terminal surface under the drop point", () => {
  const point = { x: 300, y: 100 };
  expect(isPointInsideDropTarget(point, leftSurface)).toBe(false);
  expect(isPointInsideDropTarget(point, rightSurface)).toBe(true);
});

test("rejects a drop point outside terminal surfaces", () => {
  const point = { x: 210, y: 100 };
  expect(isPointInsideDropTarget(point, leftSurface)).toBe(false);
  expect(isPointInsideDropTarget(point, rightSurface)).toBe(false);
});

test("shows the overlay after an OS drag moves onto another terminal surface", () => {
  const enteredOutside = reduceNativeDropTarget(
    EMPTY_NATIVE_DROP_TARGET_STATE,
    { type: "enter", pathCount: 3 },
    false,
  );
  expect(enteredOutside).toEqual({ pathCount: 3, overlayCount: null });

  const movedInside = reduceNativeDropTarget(
    enteredOutside,
    { type: "over" },
    true,
  );
  expect(movedInside).toEqual({ pathCount: 3, overlayCount: 3 });

  expect(reduceNativeDropTarget(movedInside, { type: "leave" }, false)).toEqual(
    EMPTY_NATIVE_DROP_TARGET_STATE,
  );
});
