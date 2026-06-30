import { expect, test } from "bun:test";

import { canApplyStorageStrategyDraft } from "./storage-strategy";

test("storage strategy draft is not applyable when selection is unchanged", () => {
  expect(
    canApplyStorageStrategyDraft({
      draft: "local",
      saved: "local",
      lfsAvailable: true,
      canSaveS3: false,
      applying: false,
    }),
  ).toBe(false);
});

test("storage strategy draft allows explicit Local only enrollment apply", () => {
  expect(
    canApplyStorageStrategyDraft({
      draft: "lfs-remote",
      saved: "local",
      lfsAvailable: true,
      canSaveS3: false,
      applying: false,
    }),
  ).toBe(true);
});

test("storage strategy draft blocks unsupported active-strategy migrations", () => {
  expect(
    canApplyStorageStrategyDraft({
      draft: "in-git",
      saved: "lfs-remote",
      lfsAvailable: true,
      canSaveS3: false,
      applying: false,
    }),
  ).toBe(false);
});

test("storage strategy draft requires valid S3 form before apply", () => {
  expect(
    canApplyStorageStrategyDraft({
      draft: "lfs-s3",
      saved: "local",
      lfsAvailable: true,
      canSaveS3: false,
      applying: false,
    }),
  ).toBe(false);
  expect(
    canApplyStorageStrategyDraft({
      draft: "lfs-s3",
      saved: "local",
      lfsAvailable: true,
      canSaveS3: true,
      applying: false,
    }),
  ).toBe(true);
});
