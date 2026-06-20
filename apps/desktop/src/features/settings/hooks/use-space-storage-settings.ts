import { useCallback, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { applyAssetsStrategy, countAssets } from "../api";
import type { AssetsStrategy, LfsState, SpaceInfo } from "@/features/space";
import {
  useSpaceStorageConfig,
  type S3TestState,
} from "./use-space-storage-config";
import { useSpaceStorageInlineSpaces } from "./use-space-storage-inline-spaces";
import { useSpaceStorageLfs } from "./use-space-storage-lfs";

interface UseSpaceStorageSettingsOptions {
  open: boolean;
  spacePath: string;
  projectPath: string;
  currentSpaceId: string | null;
  isRoot: boolean;
  spaces: Pick<SpaceInfo, "name" | "path">[];
}

export interface UseSpaceStorageSettingsResult {
  assetsStrategy: AssetsStrategy;
  savedAssetsStrategy: AssetsStrategy;
  pendingStrategy: AssetsStrategy | null;
  pendingAssetCount: number;
  lfsAvailable: boolean;
  lfsVersion: string | null;
  applyingStrategy: boolean;
  strategyInFlight: AssetsStrategy | null;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  hasSavedS3Credentials: boolean;
  s3TestState: S3TestState;
  s3TestError: string | null;
  lfsState: LfsState;
  lfsRepairInFlight: boolean;
  inlineSpaceNames: string[];
  canTestS3: boolean;
  canSaveS3: boolean;
  setS3Endpoint: (value: string) => void;
  setS3Bucket: (value: string) => void;
  setS3Region: (value: string) => void;
  setS3AccessKey: (value: string) => void;
  setS3SecretKey: (value: string) => void;
  selectStrategy: (next: AssetsStrategy) => Promise<void>;
  testS3: () => Promise<void>;
  saveS3: () => Promise<void>;
  repairLfs: () => Promise<void>;
  cancelPendingStrategy: () => void;
  confirmPendingStrategy: () => Promise<void>;
}

export function useSpaceStorageSettings({
  open,
  spacePath,
  projectPath,
  currentSpaceId,
  isRoot,
  spaces,
}: UseSpaceStorageSettingsOptions): UseSpaceStorageSettingsResult {
  const storageConfig = useSpaceStorageConfig({
    open,
    spacePath,
    projectPath,
    currentSpaceId,
  });
  const lfs = useSpaceStorageLfs({
    open,
    projectPath,
    currentSpaceId,
  });
  const { inlineSpaceNames } = useSpaceStorageInlineSpaces({
    open,
    isRoot,
    projectPath,
    spaces,
  });
  const [pendingStrategy, setPendingStrategy] = useState<AssetsStrategy | null>(
    null,
  );
  const [pendingAssetCount, setPendingAssetCount] = useState<number>(0);
  const [applyingStrategy, setApplyingStrategy] = useState(false);
  const [strategyInFlight, setStrategyInFlight] =
    useState<AssetsStrategy | null>(null);

  const countCurrentAssets = useCallback(async () => {
    if (!spacePath) return 0;
    try {
      return await countAssets({
        projectPath,
        spaceId: currentSpaceId,
      });
    } catch (err) {
      console.warn("count_assets failed, continuing without warning:", err);
      return 0;
    }
  }, [spacePath, projectPath, currentSpaceId]);

  const selectStrategy = useCallback(
    async (next: AssetsStrategy) => {
      if (next === storageConfig.savedAssetsStrategy) return;
      if ((next === "lfs-remote" || next === "lfs-s3") && !lfs.lfsAvailable) {
        return;
      }
      if (next === "lfs-s3") {
        storageConfig.setAssetsStrategy("lfs-s3");
        return;
      }
      setPendingAssetCount(await countCurrentAssets());
      setPendingStrategy(next);
    },
    [
      countCurrentAssets,
      lfs.lfsAvailable,
      storageConfig.savedAssetsStrategy,
      storageConfig.setAssetsStrategy,
    ],
  );

  const saveS3 = useCallback(async () => {
    if (!storageConfig.canSaveS3) return;
    setPendingAssetCount(await countCurrentAssets());
    setPendingStrategy("lfs-s3");
  }, [countCurrentAssets, storageConfig.canSaveS3]);

  const applyStrategy = useCallback(
    async (next: AssetsStrategy) => {
      if (!spacePath) return;
      setApplyingStrategy(true);
      setStrategyInFlight(next);
      try {
        let s3Config: {
          endpoint: string;
          bucket: string;
          region: string;
        } | null = null;
        let s3Credentials: {
          accessKey: string;
          secretKey: string;
        } | null = null;
        if (next === "lfs-s3") {
          s3Config = {
            endpoint: storageConfig.s3Endpoint.trim(),
            bucket: storageConfig.s3Bucket.trim(),
            region: storageConfig.s3Region.trim(),
          };
          if (
            storageConfig.s3AccessKey.trim() &&
            storageConfig.s3SecretKey.trim()
          ) {
            s3Credentials = {
              accessKey: storageConfig.s3AccessKey,
              secretKey: storageConfig.s3SecretKey,
            };
          }
        }
        const result = await applyAssetsStrategy({
          projectPath,
          spaceId: currentSpaceId,
          strategy: next,
          s3Config,
          s3Credentials,
        });
        storageConfig.markStrategyApplied(next);
        if (result.warnings && result.warnings.length > 0) {
          toast.warning(
            m.storage_apply_warnings({
              count: String(result.warnings.length),
            }),
            {
              description: result.warnings.join("\n"),
            },
          );
        } else {
          toast.success(m.toast_settings_saved());
        }
      } catch (err) {
        console.error("Failed to apply assets strategy:", err);
        const detail =
          typeof err === "string"
            ? err
            : ((err as { message?: string })?.message ?? "");
        toast.error(detail || m.storage_apply_failed());
        storageConfig.setAssetsStrategy(storageConfig.savedAssetsStrategy);
      } finally {
        setApplyingStrategy(false);
        setStrategyInFlight(null);
        void lfs.loadLfsState();
      }
    },
    [spacePath, storageConfig, projectPath, currentSpaceId, lfs],
  );

  const cancelPendingStrategy = useCallback(() => {
    setPendingStrategy(null);
    setPendingAssetCount(0);
  }, []);

  const confirmPendingStrategy = useCallback(async () => {
    const target = pendingStrategy;
    setPendingStrategy(null);
    setPendingAssetCount(0);
    if (target) await applyStrategy(target);
  }, [pendingStrategy, applyStrategy]);

  return {
    assetsStrategy: storageConfig.assetsStrategy,
    savedAssetsStrategy: storageConfig.savedAssetsStrategy,
    pendingStrategy,
    pendingAssetCount,
    lfsAvailable: lfs.lfsAvailable,
    lfsVersion: lfs.lfsVersion,
    applyingStrategy,
    strategyInFlight,
    s3Endpoint: storageConfig.s3Endpoint,
    s3Bucket: storageConfig.s3Bucket,
    s3Region: storageConfig.s3Region,
    s3AccessKey: storageConfig.s3AccessKey,
    s3SecretKey: storageConfig.s3SecretKey,
    hasSavedS3Credentials: storageConfig.hasSavedS3Credentials,
    s3TestState: storageConfig.s3TestState,
    s3TestError: storageConfig.s3TestError,
    lfsState: lfs.lfsState,
    lfsRepairInFlight: lfs.lfsRepairInFlight,
    inlineSpaceNames,
    canTestS3: storageConfig.canTestS3,
    canSaveS3: storageConfig.canSaveS3,
    setS3Endpoint: storageConfig.setS3Endpoint,
    setS3Bucket: storageConfig.setS3Bucket,
    setS3Region: storageConfig.setS3Region,
    setS3AccessKey: storageConfig.setS3AccessKey,
    setS3SecretKey: storageConfig.setS3SecretKey,
    selectStrategy,
    testS3: storageConfig.testS3,
    saveS3,
    repairLfs: lfs.repairLfs,
    cancelPendingStrategy,
    confirmPendingStrategy,
  };
}
