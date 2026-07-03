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
