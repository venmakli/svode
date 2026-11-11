import type { AssetsStrategy, BinaryRoutingConfig } from "@/features/space";
import * as m from "@/paraglide/messages.js";

export const BINARY_ROUTING_VERSION = 1;
const BYTES_PER_MEGABYTE = 1_000_000;
// Text formats stay in Git under every strategy.
const PROTECTED_EXTENSIONS = new Set([
  "md",
  "markdown",
  "yaml",
  "yml",
  "json",
  "csv",
  "svg",
]);

// Binary routing as Settings sends it. `set_assets_strategy` replaces the
// saved routing with it, so the `local` list is always there: without it the
// config would fall back to the default set.
export type StorageBinaryRouting = BinaryRoutingConfig & {
  localExtensions: string[];
};

// The rules of both groups: the formats of Git LFS and of `local`, and the
// size threshold they share.
export interface BinaryRoutingDraft {
  lfsExtensions: string;
  localExtensions: string;
  thresholdEnabled: boolean;
  thresholdMegabytes: string;
}

export type StorageRulesGroup = "lfs" | "local";

export type ExtensionDraftIssue = "invalid-extension" | "protected-extension";

export type BinaryRoutingDraftIssue = ExtensionDraftIssue | "invalid-threshold";

export interface NormalizedStorageExtension {
  extension: string | null;
  issue: ExtensionDraftIssue | null;
}

export interface BinaryRoutingDraftResult {
  config: StorageBinaryRouting | null;
  issue: BinaryRoutingDraftIssue | null;
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

export function binaryRoutingDraftFromConfig({
  lfsExtensions,
  localExtensions,
  lfsThresholdBytes,
}: Pick<
  StorageBinaryRouting,
  "lfsExtensions" | "localExtensions" | "lfsThresholdBytes"
>): BinaryRoutingDraft {
  return {
    lfsExtensions: extensionDraft(lfsExtensions),
    localExtensions: extensionDraft(localExtensions),
    thresholdEnabled: lfsThresholdBytes !== null,
    thresholdMegabytes:
      lfsThresholdBytes === null
        ? "10"
        : String(lfsThresholdBytes / BYTES_PER_MEGABYTE),
  };
}

// A list is edited only in its own rules group; the other one goes out as
// saved, so a hidden draft never changes or blocks what is sent.
export function binaryRoutingDraftForGroup(
  draft: BinaryRoutingDraft,
  saved: StorageBinaryRouting | null,
  group: StorageRulesGroup,
): BinaryRoutingDraft {
  if (!saved) return draft;
  return group === "local"
    ? { ...draft, lfsExtensions: extensionDraft(saved.lfsExtensions) }
    : { ...draft, localExtensions: extensionDraft(saved.localExtensions) };
}

function extensionDraft(extensions: string[]): string {
  return [...extensions].sort().join(", ");
}

export function normalizeStorageExtension(
  value: string,
): NormalizedStorageExtension {
  const extension = value.trim().replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9+_-]*$/.test(extension)) {
    return { extension: null, issue: "invalid-extension" };
  }
  if (PROTECTED_EXTENSIONS.has(extension)) {
    return { extension: null, issue: "protected-extension" };
  }
  return { extension, issue: null };
}

function normalizeExtensionDraft(
  value: string,
): { extensions: string[]; issue: null } | { issue: ExtensionDraftIssue } {
  const normalized = value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(normalizeStorageExtension);
  if (normalized.some(({ issue }) => issue === "invalid-extension")) {
    return { issue: "invalid-extension" };
  }
  if (normalized.some(({ issue }) => issue === "protected-extension")) {
    return { issue: "protected-extension" };
  }
  const extensions = [
    ...new Set(
      normalized.flatMap(({ extension }) =>
        extension === null ? [] : [extension],
      ),
    ),
  ].sort();
  return { extensions, issue: null };
}

export function normalizeBinaryRoutingDraft(
  draft: BinaryRoutingDraft,
): BinaryRoutingDraftResult {
  const lfs = normalizeExtensionDraft(draft.lfsExtensions);
  if (lfs.issue) return { config: null, issue: lfs.issue };
  const local = normalizeExtensionDraft(draft.localExtensions);
  if (local.issue) return { config: null, issue: local.issue };

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
      lfsExtensions: lfs.extensions,
      lfsThresholdBytes,
      localExtensions: local.extensions,
    },
    issue: null,
  };
}

export function sameBinaryRouting(
  left: StorageBinaryRouting | null,
  right: StorageBinaryRouting | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.version === right.version &&
    left.lfsThresholdBytes === right.lfsThresholdBytes &&
    sameList(left.lfsExtensions, right.lfsExtensions) &&
    sameList(left.localExtensions, right.localExtensions)
  );
}

function sameList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export type StorageStrategyWarningCode =
  | "foreign-lfs-config"
  | "lfs-policy-mismatch"
  | "lfs-policy-check-failed"
  | "lfs-install-failed"
  | "lfs-agent-setup-failed"
  | "lfs-agent-teardown-failed"
  | "lfs-agent-config-cleanup-failed"
  | "commit-skipped-changed-files";

// A non-fatal warning of a strategy apply; `detail` is the technical cause.
export interface StorageStrategyWarning {
  code: StorageStrategyWarningCode;
  detail?: string;
}

const STRATEGY_WARNING_TEXT: Record<StorageStrategyWarningCode, () => string> =
  {
    "foreign-lfs-config": m.storage_warning_foreign_lfs_config,
    "lfs-policy-mismatch": m.storage_warning_lfs_policy_mismatch,
    "lfs-policy-check-failed": m.storage_warning_lfs_policy_check_failed,
    "lfs-install-failed": m.storage_warning_lfs_install_failed,
    "lfs-agent-setup-failed": m.storage_warning_lfs_agent_setup_failed,
    "lfs-agent-teardown-failed": m.storage_warning_lfs_agent_teardown_failed,
    "lfs-agent-config-cleanup-failed":
      m.storage_warning_lfs_agent_config_cleanup_failed,
    "commit-skipped-changed-files":
      m.storage_warning_commit_skipped_changed_files,
  };

export function storageStrategyWarningText({
  code,
  detail,
}: StorageStrategyWarning): string {
  const text = STRATEGY_WARNING_TEXT[code]();
  return detail ? `${text} ${m.storage_warning_detail({ detail })}` : text;
}
