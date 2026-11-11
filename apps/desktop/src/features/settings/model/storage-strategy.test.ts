import { expect, test } from "bun:test";

import { setLocale } from "@/paraglide/runtime";
import {
  canApplyStorageStrategyDraft,
  canReapplyLfsPolicy,
  canRunLfsPolicyDiagnostic,
  canRunLfsRemoteDiagnostic,
  canShowLfsStatePanel,
  binaryRoutingDraftForGroup,
  binaryRoutingDraftFromConfig,
  normalizeBinaryRoutingDraft,
  normalizeStorageExtension,
  sameBinaryRouting,
  storageStrategyWarningText,
  type BinaryRoutingDraft,
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

const draft = (overrides: Partial<BinaryRoutingDraft> = {}) => ({
  lfsExtensions: "",
  localExtensions: "",
  thresholdEnabled: false,
  thresholdMegabytes: "10",
  ...overrides,
});

test("routing draft normalizes both format lists and an enabled MB threshold", () => {
  const result = normalizeBinaryRoutingDraft(
    draft({
      lfsExtensions: ".PSD, mp4 psd, ZIP",
      localExtensions: "JPG, .png jpg",
      thresholdEnabled: true,
      thresholdMegabytes: "12.5",
    }),
  );

  expect(result.issue).toBeNull();
  expect(result.config).toEqual({
    version: 1,
    lfsExtensions: ["mp4", "psd", "zip"],
    lfsThresholdBytes: 12_500_000,
    localExtensions: ["jpg", "png"],
  });
});

test("routing draft rejects protected and malformed extensions of either list", () => {
  expect(
    normalizeBinaryRoutingDraft(draft({ lfsExtensions: "svg" })).issue,
  ).toBe("protected-extension");
  expect(
    normalizeBinaryRoutingDraft(draft({ localExtensions: "md" })).issue,
  ).toBe("protected-extension");
  expect(
    normalizeBinaryRoutingDraft(draft({ lfsExtensions: "*.psd" })).issue,
  ).toBe("invalid-extension");
  expect(
    normalizeBinaryRoutingDraft(draft({ localExtensions: "docs/a.png" })).issue,
  ).toBe("invalid-extension");
  expect(normalizeBinaryRoutingDraft(draft({ lfsExtensions: "." })).issue).toBe(
    "invalid-extension",
  );
  expect(
    normalizeBinaryRoutingDraft(
      draft({
        lfsExtensions: "psd",
        thresholdEnabled: true,
        thresholdMegabytes: "0.0000001",
      }),
    ).issue,
  ).toBe("invalid-threshold");
});

test("an empty local list stays an empty list: only the size rule applies", () => {
  expect(
    normalizeBinaryRoutingDraft(
      draft({ thresholdEnabled: true, thresholdMegabytes: "10" }),
    ).config,
  ).toEqual({
    version: 1,
    lfsExtensions: [],
    lfsThresholdBytes: 10_000_000,
    localExtensions: [],
  });
});

test("single extension input normalizes user-friendly values", () => {
  expect(normalizeStorageExtension(" .BLEND ")).toEqual({
    extension: "blend",
    issue: null,
  });
  expect(normalizeStorageExtension("*.psd")).toEqual({
    extension: null,
    issue: "invalid-extension",
  });
  expect(normalizeStorageExtension(".svg")).toEqual({
    extension: null,
    issue: "protected-extension",
  });
});

test("routing draft round-trips both lists and a disabled threshold", () => {
  const config = {
    version: 1,
    lfsExtensions: ["zip", "psd"],
    lfsThresholdBytes: null,
    localExtensions: ["png", "jpg"],
  };
  const result = normalizeBinaryRoutingDraft(
    binaryRoutingDraftFromConfig(config),
  );

  expect(result.config).toEqual({
    version: 1,
    lfsExtensions: ["psd", "zip"],
    lfsThresholdBytes: null,
    localExtensions: ["jpg", "png"],
  });
  expect(sameBinaryRouting(result.config, result.config)).toBe(true);
  expect(
    sameBinaryRouting(result.config, {
      ...result.config!,
      localExtensions: ["jpg"],
    }),
  ).toBe(false);
});

test("each list is edited in its own group; the hidden one goes out as saved", () => {
  const saved = {
    version: 1,
    lfsExtensions: ["psd"],
    lfsThresholdBytes: 10_000_000,
    localExtensions: ["mp4", "jpg"],
  };
  const edited = draft({
    lfsExtensions: "svg",
    localExtensions: "png",
    thresholdEnabled: true,
    thresholdMegabytes: "5",
  });

  expect(binaryRoutingDraftForGroup(edited, saved, "local")).toEqual({
    ...edited,
    lfsExtensions: "psd",
  });
  expect(binaryRoutingDraftForGroup(edited, saved, "lfs")).toEqual({
    ...edited,
    localExtensions: "jpg, mp4",
  });
  // A protected format in the hidden LFS draft does not block the local save.
  expect(
    normalizeBinaryRoutingDraft(
      binaryRoutingDraftForGroup(edited, saved, "local"),
    ).config,
  ).toEqual({
    version: 1,
    lfsExtensions: ["psd"],
    lfsThresholdBytes: 5_000_000,
    localExtensions: ["png"],
  });
  expect(binaryRoutingDraftForGroup(edited, null, "lfs")).toBe(edited);
});

test("strategy warnings are worded by code in the interface language", () => {
  setLocale("ru", { reload: false });
  const commit = storageStrategyWarningText({
    code: "commit-skipped-changed-files",
  });
  expect(commit.startsWith("В файлах хранения")).toBe(true);
  expect(commit.includes("dirty")).toBe(false);
  setLocale("en", { reload: false });
  expect(
    storageStrategyWarningText({
      code: "lfs-install-failed",
      detail: "hooks locked",
    }),
  ).toBe("Couldn't turn on Git LFS in this repository. Details: hooks locked");
});
