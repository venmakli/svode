import { expect, test } from "bun:test";

import { petalScaleForProgress } from "./project-loading-logo";

const PETAL_SIZES = [175, 210, 230, 240];

test("petal animation maps every petal to the shared absolute size range", () => {
  for (const baseSize of PETAL_SIZES) {
    expect(roundedTargetSize(baseSize, 0)).toBe(175);
    expect(roundedTargetSize(baseSize, 1)).toBe(240);
  }
});

test("petal animation chooses the same absolute midpoint for every base size", () => {
  const targetSizes = PETAL_SIZES.map(
    (baseSize) => baseSize * petalScaleForProgress(baseSize, 0.5),
  );

  expect(targetSizes).toEqual([207.5, 207.5, 207.5, 207.5]);
});

function roundedTargetSize(baseSize: number, progress: number) {
  return Number(
    (baseSize * petalScaleForProgress(baseSize, progress)).toFixed(6),
  );
}
