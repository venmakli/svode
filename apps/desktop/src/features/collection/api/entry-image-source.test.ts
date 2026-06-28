import { expect, test } from "bun:test";

import { spaceRelativeImageAbsPath } from "./entry-image-source";

test("spaceRelativeImageAbsPath resolves inherited inline cover path from space root", () => {
  expect(
    spaceRelativeImageAbsPath(
      "/project/engineering",
      "../.assets/cover.png",
    ),
  ).toBe("/project/.assets/cover.png");
});

test("spaceRelativeImageAbsPath keeps local space asset paths under the space", () => {
  expect(
    spaceRelativeImageAbsPath("/project/research", ".assets/cover.png"),
  ).toBe("/project/research/.assets/cover.png");
});
