import { expect, test } from "bun:test";

import {
  canApplyStorageStrategyDraft,
  canRunLfsRemoteDiagnostic,
  canShowLfsStatePanel,
} from "./storage-strategy";

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

test("LFS remote diagnostics require current loaded lfs-remote config", () => {
  expect(
    canRunLfsRemoteDiagnostic({
      configLoaded: false,
      strategy: "lfs-remote",
    }),
  ).toBe(false);
  expect(
    canRunLfsRemoteDiagnostic({
      configLoaded: true,
      strategy: "local",
    }),
  ).toBe(false);
  expect(
    canRunLfsRemoteDiagnostic({
      configLoaded: true,
      strategy: "lfs-remote",
    }),
  ).toBe(true);
});

test("LFS state panel requires current loaded LFS strategy", () => {
  expect(
    canShowLfsStatePanel({
      configLoaded: false,
      strategy: "lfs-s3",
    }),
  ).toBe(false);
  expect(
    canShowLfsStatePanel({
      configLoaded: true,
      strategy: "in-git",
    }),
  ).toBe(false);
  expect(
    canShowLfsStatePanel({
      configLoaded: true,
      strategy: "lfs-s3",
    }),
  ).toBe(true);
  expect(
    canShowLfsStatePanel({
      configLoaded: true,
      strategy: "lfs-remote",
    }),
  ).toBe(true);
});
