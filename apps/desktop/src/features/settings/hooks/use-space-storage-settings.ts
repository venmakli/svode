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
  const {
    assetsStrategy,
    savedAssetsStrategy,
    s3Endpoint,
    s3Bucket,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    hasSavedS3Credentials,
    s3TestState,
    s3TestError,
    canTestS3,
    canSaveS3,
    setAssetsStrategy,
    setS3Endpoint,
    setS3Bucket,
    setS3Region,
    setS3AccessKey,
    setS3SecretKey,
    testS3,
    markStrategyApplied,
  } = storageConfig;
  const {
    lfsAvailable,
    lfsVersion,
    lfsState,
    lfsRepairInFlight,
    loadLfsState,
    repairLfs,
  } = lfs;
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

  const countCurrentAssets = useCallback(async (): Promise<number | null> => {
    if (!spacePath) return 0;
    try {
      return await countAssets({
        projectPath,
        spaceId: currentSpaceId,
      });
    } catch (err) {
      console.warn("count_assets failed, blocking strategy apply:", err);
      toast.error(m.storage_count_failed());
      return null;
    }
  }, [spacePath, projectPath, currentSpaceId]);

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
            endpoint: s3Endpoint.trim(),
            bucket: s3Bucket.trim(),
            region: s3Region.trim(),
          };
          if (s3AccessKey.trim() && s3SecretKey.trim()) {
            s3Credentials = {
              accessKey: s3AccessKey,
              secretKey: s3SecretKey,
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
        markStrategyApplied(next);
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
        setAssetsStrategy(savedAssetsStrategy);
      } finally {
        setApplyingStrategy(false);
        setStrategyInFlight(null);
        void loadLfsState();
      }
    },
    [
      currentSpaceId,
      loadLfsState,
      markStrategyApplied,
      projectPath,
      s3AccessKey,
      s3Bucket,
      s3Endpoint,
      s3Region,
      s3SecretKey,
      savedAssetsStrategy,
      setAssetsStrategy,
      spacePath,
    ],
  );

  const confirmOrApplyStrategy = useCallback(
    async (next: AssetsStrategy) => {
      const assetCount = await countCurrentAssets();
      if (assetCount === null) {
        setAssetsStrategy(savedAssetsStrategy);
        setPendingAssetCount(0);
        setPendingStrategy(null);
        return;
      }
      if (assetCount > 0) {
        setPendingAssetCount(assetCount);
        setPendingStrategy(next);
        return;
      }
      setPendingAssetCount(0);
      setPendingStrategy(null);
      await applyStrategy(next);
    },
    [applyStrategy, countCurrentAssets, savedAssetsStrategy, setAssetsStrategy],
  );

  const rejectUnsupportedMigration = useCallback(() => {
    toast.error(m.storage_migration_unsupported());
    setAssetsStrategy(savedAssetsStrategy);
    setPendingAssetCount(0);
    setPendingStrategy(null);
  }, [savedAssetsStrategy, setAssetsStrategy]);

  const selectStrategy = useCallback(
    async (next: AssetsStrategy) => {
      if (next === savedAssetsStrategy) {
        setAssetsStrategy(savedAssetsStrategy);
        setPendingAssetCount(0);
        setPendingStrategy(null);
        return;
      }
      if (savedAssetsStrategy !== "local") {
        rejectUnsupportedMigration();
        return;
      }
      if ((next === "lfs-remote" || next === "lfs-s3") && !lfsAvailable) {
        return;
      }
      if (next === "lfs-s3") {
        setAssetsStrategy("lfs-s3");
        return;
      }
      await confirmOrApplyStrategy(next);
    },
    [
      confirmOrApplyStrategy,
      lfsAvailable,
      rejectUnsupportedMigration,
      savedAssetsStrategy,
      setAssetsStrategy,
    ],
  );

  const saveS3 = useCallback(async () => {
    if (!canSaveS3) return;
    if (savedAssetsStrategy !== "local" && savedAssetsStrategy !== "lfs-s3") {
      rejectUnsupportedMigration();
      return;
    }
    if (savedAssetsStrategy === "lfs-s3") {
      await applyStrategy("lfs-s3");
      return;
    }
    await confirmOrApplyStrategy("lfs-s3");
  }, [
    applyStrategy,
    canSaveS3,
    confirmOrApplyStrategy,
    rejectUnsupportedMigration,
    savedAssetsStrategy,
  ]);

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
    assetsStrategy,
    savedAssetsStrategy,
    pendingStrategy,
    pendingAssetCount,
    lfsAvailable,
    lfsVersion,
    applyingStrategy,
    strategyInFlight,
    s3Endpoint,
    s3Bucket,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    hasSavedS3Credentials,
    s3TestState,
    s3TestError,
    lfsState,
    lfsRepairInFlight,
    inlineSpaceNames,
    canTestS3,
    canSaveS3,
    setS3Endpoint,
    setS3Bucket,
    setS3Region,
    setS3AccessKey,
    setS3SecretKey,
    selectStrategy,
    testS3,
    saveS3,
    repairLfs,
    cancelPendingStrategy,
    confirmPendingStrategy,
  };
}
