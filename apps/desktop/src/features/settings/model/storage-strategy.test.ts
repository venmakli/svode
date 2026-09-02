import { expect, test } from "bun:test";

import {
  canApplyStorageStrategyDraft,
  canReapplyLfsPolicy,
  canRunLfsPolicyDiagnostic,
  canRunLfsRemoteDiagnostic,
  canShowLfsStatePanel,
  lfsRoutingDraftFromConfig,
  normalizeLfsRoutingDraft,
  sameBinaryRouting,
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

test("repository LFS policy diagnostics require a current loaded LFS strategy", () => {
  expect(
    canRunLfsPolicyDiagnostic({
      active: true,
      configLoaded: false,
      inheritedFromProject: false,
      strategy: "lfs-remote",
    }),
  ).toBe(false);
  expect(
    canRunLfsPolicyDiagnostic({
      active: true,
      configLoaded: true,
      inheritedFromProject: false,
      strategy: "in-git",
    }),
  ).toBe(false);
  expect(
    canRunLfsPolicyDiagnostic({
      active: true,
      configLoaded: true,
      inheritedFromProject: false,
      strategy: "lfs-remote",
    }),
  ).toBe(true);
  expect(
    canRunLfsPolicyDiagnostic({
      active: true,
      configLoaded: true,
      inheritedFromProject: false,
      strategy: "lfs-s3",
    }),
  ).toBe(true);
  expect(
    canRunLfsPolicyDiagnostic({
      active: false,
      configLoaded: true,
      inheritedFromProject: false,
      strategy: "lfs-remote",
    }),
  ).toBe(false);
  expect(
    canRunLfsPolicyDiagnostic({
      active: true,
      configLoaded: true,
      inheritedFromProject: true,
      strategy: "lfs-remote",
    }),
  ).toBe(false);
});

test("active LFS policy can be explicitly reapplied when its config is ready", () => {
  expect(
    canReapplyLfsPolicy({
      strategy: "lfs-remote",
      lfsAvailable: true,
      s3ConfigReady: false,
      applying: false,
    }),
  ).toBe(true);
  expect(
    canReapplyLfsPolicy({
      strategy: "lfs-s3",
      lfsAvailable: true,
      s3ConfigReady: false,
      applying: false,
    }),
  ).toBe(false);
  expect(
    canReapplyLfsPolicy({
      strategy: "lfs-s3",
      lfsAvailable: true,
      s3ConfigReady: true,
      applying: false,
    }),
  ).toBe(true);
  expect(
    canReapplyLfsPolicy({
      strategy: "lfs-remote",
      lfsAvailable: false,
      s3ConfigReady: false,
      applying: false,
    }),
  ).toBe(false);
});

test("LFS routing draft normalizes extensions and an enabled MB threshold", () => {
  const result = normalizeLfsRoutingDraft({
    extensions: ".PSD, mp4 psd, ZIP",
    thresholdEnabled: true,
    thresholdMegabytes: "12.5",
  });

  expect(result.issue).toBeNull();
  expect(result.config).toEqual({
    version: 1,
    lfsExtensions: ["mp4", "psd", "zip"],
    lfsThresholdBytes: 12_500_000,
  });
});

test("LFS routing draft rejects protected and malformed extensions", () => {
  expect(
    normalizeLfsRoutingDraft({
      extensions: "svg",
      thresholdEnabled: false,
      thresholdMegabytes: "10",
    }).issue,
  ).toBe("protected-extension");
  expect(
    normalizeLfsRoutingDraft({
      extensions: "*.psd",
      thresholdEnabled: false,
      thresholdMegabytes: "10",
    }).issue,
  ).toBe("invalid-extension");
  expect(
    normalizeLfsRoutingDraft({
      extensions: ".",
      thresholdEnabled: false,
      thresholdMegabytes: "10",
    }).issue,
  ).toBe("invalid-extension");
  expect(
    normalizeLfsRoutingDraft({
      extensions: "psd",
      thresholdEnabled: true,
      thresholdMegabytes: "0.0000001",
    }).issue,
  ).toBe("invalid-threshold");
});

test("LFS routing draft round-trips a disabled threshold", () => {
  const draft = lfsRoutingDraftFromConfig(["zip", "psd"], null);
  const result = normalizeLfsRoutingDraft(draft);

  expect(result.config).toEqual({
    version: 1,
    lfsExtensions: ["psd", "zip"],
    lfsThresholdBytes: null,
  });
  expect(sameBinaryRouting(result.config, result.config)).toBe(true);
});
