import type { AssetsStrategy, BinaryRoutingConfig } from "@/features/space";

export const BINARY_ROUTING_VERSION = 1;
const BYTES_PER_MEGABYTE = 1_000_000;
const PROTECTED_LFS_EXTENSIONS = new Set([
  "md",
  "markdown",
  "yaml",
  "yml",
  "json",
  "csv",
  "svg",
]);

export interface LfsRoutingDraft {
  extensions: string;
  thresholdEnabled: boolean;
  thresholdMegabytes: string;
}

export type LfsRoutingDraftIssue =
  | "invalid-extension"
  | "protected-extension"
  | "invalid-threshold";

export interface LfsRoutingDraftResult {
  config: BinaryRoutingConfig | null;
  issue: LfsRoutingDraftIssue | null;
}

export type LfsStorageStrategy = Extract<
  AssetsStrategy,
  "lfs-remote" | "lfs-s3"
>;

export interface StorageStrategyDraftState {
  draft: AssetsStrategy;
  saved: AssetsStrategy;
  lfsAvailable: boolean;
  canSaveS3: boolean;
  applying: boolean;
}

export interface StorageLfsDiagnosticsState {
  configLoaded: boolean;
  strategy: AssetsStrategy;
}

export interface StorageLfsPolicyDiagnosticsState extends StorageLfsDiagnosticsState {
  active: boolean;
  inheritedFromProject: boolean;
}

export interface ReapplyLfsPolicyState {
  strategy: AssetsStrategy;
  lfsAvailable: boolean;
  s3ConfigReady: boolean;
  applying: boolean;
}

export function isStorageStrategyDraftChanged({
  draft,
  saved,
}: Pick<StorageStrategyDraftState, "draft" | "saved">): boolean {
  return draft !== saved;
}

export function canApplyStorageStrategyDraft({
  draft,
  saved,
  lfsAvailable,
  canSaveS3,
  applying,
}: StorageStrategyDraftState): boolean {
  if (applying || !isStorageStrategyDraftChanged({ draft, saved })) {
    return false;
  }
  if (saved !== "local") {
    return false;
  }
  if ((draft === "lfs-remote" || draft === "lfs-s3") && !lfsAvailable) {
    return false;
  }
  if (draft === "lfs-s3" && !canSaveS3) {
    return false;
  }
  return true;
}

export function canRunLfsRemoteDiagnostic({
  configLoaded,
  strategy,
}: StorageLfsDiagnosticsState): boolean {
  return configLoaded && strategy === "lfs-remote";
}

export function canRunLfsPolicyDiagnostic({
  active,
  configLoaded,
  inheritedFromProject,
  strategy,
}: StorageLfsPolicyDiagnosticsState): boolean {
  return (
    active &&
    configLoaded &&
    !inheritedFromProject &&
    isLfsStorageStrategy(strategy)
  );
}

export function canReapplyLfsPolicy({
  strategy,
  lfsAvailable,
  s3ConfigReady,
  applying,
}: ReapplyLfsPolicyState): boolean {
  if (applying || !lfsAvailable || !isLfsStorageStrategy(strategy)) {
    return false;
  }
  return strategy !== "lfs-s3" || s3ConfigReady;
}

export function isLfsStorageStrategy(
  strategy: AssetsStrategy,
): strategy is LfsStorageStrategy {
  return strategy === "lfs-remote" || strategy === "lfs-s3";
}

export function canShowLfsStatePanel({
  configLoaded,
  strategy,
}: StorageLfsDiagnosticsState): boolean {
  return configLoaded && isLfsStorageStrategy(strategy);
}

export function storageTargetKey(
  projectPath: string,
  spaceId: string | null,
): string {
  return `${projectPath}\u0000${spaceId ?? ""}`;
}

export function lfsRoutingDraftFromConfig(
  extensions: string[],
  thresholdBytes: number | null,
): LfsRoutingDraft {
  return {
    extensions: [...extensions].sort().join(", "),
    thresholdEnabled: thresholdBytes !== null,
    thresholdMegabytes:
      thresholdBytes === null
        ? "10"
        : String(thresholdBytes / BYTES_PER_MEGABYTE),
  };
}

export function normalizeLfsRoutingDraft(
  draft: LfsRoutingDraft,
): LfsRoutingDraftResult {
  const extensionTokens = draft.extensions
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedExtensions = extensionTokens.map((value) =>
    value.replace(/^\.+/, "").toLowerCase(),
  );
  const extensions = [...new Set(normalizedExtensions)].sort();
  if (
    normalizedExtensions.some((extension) => extension.length === 0) ||
    extensions.some((extension) => !/^[a-z0-9][a-z0-9+_-]*$/.test(extension))
  ) {
    return { config: null, issue: "invalid-extension" };
  }
  if (extensions.some((extension) => PROTECTED_LFS_EXTENSIONS.has(extension))) {
    return { config: null, issue: "protected-extension" };
  }

  let lfsThresholdBytes: number | null = null;
  if (draft.thresholdEnabled) {
    const megabytes = Number(draft.thresholdMegabytes);
    const bytes = Math.round(megabytes * BYTES_PER_MEGABYTE);
    if (
      !Number.isFinite(megabytes) ||
      megabytes <= 0 ||
      bytes <= 0 ||
      !Number.isSafeInteger(bytes)
    ) {
      return { config: null, issue: "invalid-threshold" };
    }
    lfsThresholdBytes = bytes;
  }

  return {
    config: {
      version: BINARY_ROUTING_VERSION,
      lfsExtensions: extensions,
      lfsThresholdBytes,
    },
    issue: null,
  };
}

export function sameBinaryRouting(
  left: BinaryRoutingConfig | null,
  right: BinaryRoutingConfig | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.version === right.version &&
    left.lfsThresholdBytes === right.lfsThresholdBytes &&
    left.lfsExtensions.length === right.lfsExtensions.length &&
    left.lfsExtensions.every(
      (extension, index) => extension === right.lfsExtensions[index],
    )
  );
}
