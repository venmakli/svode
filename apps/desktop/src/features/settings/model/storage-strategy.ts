import type { AssetsStrategy } from "@/features/space";

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
