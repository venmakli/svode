import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { applyAssetsStrategy, countAssets, getAssetsConfig } from "../api";
import type {
  AssetsS3Config,
  AssetsStrategy,
  LfsState,
  SpaceInfo,
} from "@/features/space";
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
  savedS3Config: AssetsS3Config | null;
  projectAssetsStrategy: AssetsStrategy;
  projectS3Config: AssetsS3Config | null;
  projectDefaultApplied: boolean;
  inheritedFromProject: boolean;
  ownerSpaceId: string | null;
  currentSpacePath: string;
  currentSpaceId: string | null;
  isRoot: boolean;
  pendingStrategy: AssetsStrategy | null;
  pendingAssetCount: number;
  lfsAvailable: boolean;
  lfsVersion: string | null;
  applyingStrategy: boolean;
  strategyInFlight: AssetsStrategy | null;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3Prefix: string;
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
  setS3Prefix: (value: string) => void;
  setS3AccessKey: (value: string) => void;
  setS3SecretKey: (value: string) => void;
  selectStrategy: (next: AssetsStrategy) => Promise<void>;
  useProjectStorageSetting: () => Promise<void>;
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
    savedS3Config,
    defaultS3Prefix,
    inheritedFromProject,
    ownerSpaceId,
    s3Endpoint,
    s3Bucket,
    s3Region,
    s3Prefix,
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
    setS3Prefix,
    setS3AccessKey,
    setS3SecretKey,
    testS3,
    markStrategyApplied,
  } = storageConfig;
  const [projectAssetsStrategy, setProjectAssetsStrategy] =
    useState<AssetsStrategy>("local");
  const [projectS3Config, setProjectS3Config] =
    useState<AssetsS3Config | null>(null);
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

  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;

    void getAssetsConfig({ projectPath, spaceId: null })
      .then((config) => {
        if (!cancelled) {
          setProjectAssetsStrategy(config.strategy);
          setProjectS3Config(config.s3 ?? null);
        }
      })
      .catch((err) => {
        console.error("Failed to load project storage settings:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

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
        let s3Config: AssetsS3Config | null = null;
        let s3Credentials: {
          accessKey: string;
          secretKey: string;
        } | null = null;
        if (next === "lfs-s3") {
          s3Config = {
            endpoint: s3Endpoint.trim(),
            bucket: s3Bucket.trim(),
            region: s3Region.trim(),
            prefix: s3Prefix.trim(),
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
        markStrategyApplied(next, s3Config);
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
      s3Prefix,
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

  const projectDefaultApplied =
    savedAssetsStrategy === projectAssetsStrategy &&
    (projectAssetsStrategy !== "lfs-s3" ||
      (sameS3Connection(savedS3Config, projectS3Config) &&
        savedS3Config?.prefix === defaultS3Prefix));

  const useProjectStorageSetting = useCallback(async () => {
    if (projectAssetsStrategy === "lfs-s3") {
      if (savedAssetsStrategy !== "local" && savedAssetsStrategy !== "lfs-s3") {
        rejectUnsupportedMigration();
        return;
      }
      if (!lfsAvailable) return;
      if (!projectS3Config) {
        toast.error(m.storage_project_setting_missing_s3());
        return;
      }
      setAssetsStrategy("lfs-s3");
      setS3Endpoint(projectS3Config.endpoint);
      setS3Bucket(projectS3Config.bucket);
      setS3Region(projectS3Config.region);
      setS3Prefix(defaultS3Prefix);
      setS3AccessKey("");
      setS3SecretKey("");
      toast(m.storage_project_setting_loaded());
      return;
    }
    await selectStrategy(projectAssetsStrategy);
  }, [
    projectAssetsStrategy,
    projectS3Config,
    defaultS3Prefix,
    lfsAvailable,
    rejectUnsupportedMigration,
    savedAssetsStrategy,
    selectStrategy,
    setS3AccessKey,
    setAssetsStrategy,
    setS3Bucket,
    setS3Endpoint,
    setS3Prefix,
    setS3Region,
    setS3SecretKey,
  ]);

  return {
    assetsStrategy,
    savedAssetsStrategy,
    savedS3Config,
    projectAssetsStrategy,
    projectS3Config,
    projectDefaultApplied,
    inheritedFromProject,
    ownerSpaceId,
    currentSpacePath: spacePath,
    currentSpaceId,
    isRoot,
    pendingStrategy,
    pendingAssetCount,
    lfsAvailable,
    lfsVersion,
    applyingStrategy,
    strategyInFlight,
    s3Endpoint,
    s3Bucket,
    s3Region,
    s3Prefix,
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
    setS3Prefix,
    setS3AccessKey,
    setS3SecretKey,
    selectStrategy,
    useProjectStorageSetting,
    testS3,
    saveS3,
    repairLfs,
    cancelPendingStrategy,
    confirmPendingStrategy,
  };
}

function sameS3Connection(
  left: AssetsS3Config | null,
  right: AssetsS3Config | null,
) {
  return (
    left !== null &&
    right !== null &&
    left?.endpoint === right?.endpoint &&
    left?.bucket === right?.bucket &&
    left?.region === right?.region
  );
}
