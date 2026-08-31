import { expect, test } from "bun:test";

import {
  coverImageAbsPath,
  coverPathForUploadedAsset,
} from "./cover-paths";

test("coverPathForUploadedAsset keeps root project assets space-relative", () => {
  expect(
    coverPathForUploadedAsset({
      spacePath: "/project",
      assetOwnerPath: "/project",
      assetRelPath: ".assets/cover.png",
    }),
  ).toBe(".assets/cover.png");
});

test("coverPathForUploadedAsset points inline space covers back to project pool", () => {
  expect(
    coverPathForUploadedAsset({
      spacePath: "/project/engineering",
      assetOwnerPath: "/project",
      assetRelPath: ".assets/cover.png",
    }),
  ).toBe("../.assets/cover.png");
});

test("coverPathForUploadedAsset keeps repo-owned space assets local", () => {
  expect(
    coverPathForUploadedAsset({
      spacePath: "/project/research",
      assetOwnerPath: "/project/research",
      assetRelPath: ".assets/cover.png",
    }),
  ).toBe(".assets/cover.png");
});

test("coverImageAbsPath normalizes inherited inline cover paths", () => {
  expect(coverImageAbsPath("/project/engineering", "../.assets/cover.png")).toBe(
    "/project/.assets/cover.png",
  );
});
