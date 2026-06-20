import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  applyAssetsStrategy,
  checkS3Connection,
  countAssets,
  getLfsState,
  getSettingsGitAvailability,
  getSettingsSpaceConfig,
  getSpaceGitType,
  hasS3Credentials,
  listenLfsStateChanged,
  repairLfs,
} from "../api";
import type { AssetsStrategy, LfsState, SpaceInfo } from "@/features/space";

type S3TestState = "idle" | "testing" | "ok" | "fail";

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
  const [assetsStrategy, setAssetsStrategy] = useState<AssetsStrategy>("local");
  const [savedAssetsStrategy, setSavedAssetsStrategy] =
    useState<AssetsStrategy>("local");
  const [pendingStrategy, setPendingStrategy] = useState<AssetsStrategy | null>(
    null,
  );
  const [pendingAssetCount, setPendingAssetCount] = useState<number>(0);
  const [lfsAvailable, setLfsAvailable] = useState<boolean>(false);
  const [lfsVersion, setLfsVersion] = useState<string | null>(null);
  const [applyingStrategy, setApplyingStrategy] = useState(false);
  const [strategyInFlight, setStrategyInFlight] =
    useState<AssetsStrategy | null>(null);
  const [s3Endpoint, setS3Endpoint] = useState("");
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3Region, setS3Region] = useState("");
  const [s3AccessKey, setS3AccessKey] = useState("");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [hasSavedS3Credentials, setHasSavedS3Credentials] = useState(false);
  const [s3TestState, setS3TestState] = useState<S3TestState>("idle");
  const [s3TestError, setS3TestError] = useState<string | null>(null);
  const [lfsState, setLfsState] = useState<LfsState>("n/a");
  const [lfsRepairInFlight, setLfsRepairInFlight] = useState(false);
  const [inlineSpaceNames, setInlineSpaceNames] = useState<string[]>([]);

  const canTestS3 =
    s3TestState !== "testing" &&
    Boolean(s3Endpoint.trim() && s3Bucket.trim() && s3Region.trim());
  const canSaveS3 = Boolean(
    s3Endpoint.trim() &&
    s3Bucket.trim() &&
    s3Region.trim() &&
    (hasSavedS3Credentials || (s3AccessKey.trim() && s3SecretKey.trim())),
  );

  const loadStorageConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      const strategy: AssetsStrategy = cfg.assets?.strategy ?? "local";
      setAssetsStrategy(strategy);
      setSavedAssetsStrategy(strategy);
      const s3 = cfg.assets?.s3;
      setS3Endpoint(s3?.endpoint ?? "");
      setS3Bucket(s3?.bucket ?? "");
      setS3Region(s3?.region ?? "");
      setS3AccessKey("");
      setS3SecretKey("");
      setS3TestState("idle");
      setS3TestError(null);
      try {
        const present = await hasS3Credentials({
          projectPath,
          spaceId: currentSpaceId,
        });
        setHasSavedS3Credentials(present);
      } catch {
        setHasSavedS3Credentials(false);
      }
    } catch (err) {
      console.error("Failed to load storage settings:", err);
    }
  }, [spacePath, projectPath, currentSpaceId]);

  const loadLfsState = useCallback(async () => {
    if (!projectPath) return;
    try {
      const state = await getLfsState({
        projectPath,
        spaceId: currentSpaceId,
      });
      setLfsState(state);
    } catch (err) {
      console.warn("get_lfs_state failed:", err);
      setLfsState("n/a");
    }
  }, [projectPath, currentSpaceId]);

  const loadInlineSpaceNames = useCallback(async () => {
    if (!isRoot || !projectPath || spaces.length === 0) {
      setInlineSpaceNames([]);
      return;
    }
    const types = await Promise.all(
      spaces.map(async (space) => {
        try {
          const type = await getSpaceGitType({
            projectPath,
            spacePath: space.path,
          });
          return { space, type };
        } catch {
          return { space, type: null };
        }
      }),
    );
    setInlineSpaceNames(
      types
        .filter((entry) => entry.type === "inline")
        .map((entry) => entry.space.name),
    );
  }, [isRoot, projectPath, spaces]);

  const loadLfsAvailability = useCallback(async () => {
    try {
      const avail = await getSettingsGitAvailability();
      setLfsAvailable(avail.gitLfs);
      setLfsVersion(avail.gitVersion);
    } catch {
      setLfsAvailable(false);
      setLfsVersion(null);
    }
  }, []);

  useEffect(() => {
    if (!open || !spacePath) return;
    void loadStorageConfig();
    void loadLfsAvailability();
    void loadLfsState();
    void loadInlineSpaceNames();
  }, [
    open,
    spacePath,
    loadStorageConfig,
    loadLfsAvailability,
    loadLfsState,
    loadInlineSpaceNames,
  ]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenLfsStateChanged((event) => {
      if (cancelled) return;
      if (event.payload.projectPath !== projectPath) return;
      if ((event.payload.spaceId ?? null) !== currentSpaceId) return;
      setLfsState(event.payload.state);
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [open, projectPath, currentSpaceId]);

  const selectStrategy = useCallback(
    async (next: AssetsStrategy) => {
      if (next === savedAssetsStrategy) return;
      if ((next === "lfs-remote" || next === "lfs-s3") && !lfsAvailable) {
        return;
      }
      if (next === "lfs-s3") {
        setAssetsStrategy("lfs-s3");
        return;
      }
      let count = 0;
      if (spacePath) {
        try {
          count = await countAssets({
            projectPath,
            spaceId: currentSpaceId,
          });
        } catch (err) {
          console.warn("count_assets failed, continuing without warning:", err);
        }
      }
      setPendingAssetCount(count);
      setPendingStrategy(next);
    },
    [savedAssetsStrategy, lfsAvailable, spacePath, projectPath, currentSpaceId],
  );

  const testS3 = useCallback(async () => {
    if (!canTestS3) return;
    if (!s3AccessKey.trim() || !s3SecretKey.trim()) {
      setS3TestState("fail");
      setS3TestError(m.storage_s3_test_needs_keys());
      return;
    }
    setS3TestState("testing");
    setS3TestError(null);
    try {
      await checkS3Connection({
        endpoint: s3Endpoint.trim(),
        bucket: s3Bucket.trim(),
        region: s3Region.trim(),
        accessKey: s3AccessKey,
        secretKey: s3SecretKey,
      });
      setS3TestState("ok");
    } catch (err) {
      const detail =
        typeof err === "string"
          ? err
          : ((err as { message?: string })?.message ?? "");
      setS3TestState("fail");
      setS3TestError(detail || m.storage_s3_test_failed());
    }
  }, [canTestS3, s3AccessKey, s3SecretKey, s3Endpoint, s3Bucket, s3Region]);

  const saveS3 = useCallback(async () => {
    if (!canSaveS3) return;
    let count = 0;
    if (spacePath) {
      try {
        count = await countAssets({
          projectPath,
          spaceId: currentSpaceId,
        });
      } catch (err) {
        console.warn("count_assets failed, continuing without warning:", err);
      }
    }
    setPendingAssetCount(count);
    setPendingStrategy("lfs-s3");
  }, [canSaveS3, spacePath, projectPath, currentSpaceId]);

  const handleRepairLfs = useCallback(async () => {
    if (!projectPath || lfsRepairInFlight) return;
    setLfsRepairInFlight(true);
    try {
      const next = await repairLfs({
        projectPath,
        spaceId: currentSpaceId,
      });
      setLfsState(next);
    } catch (err) {
      console.error("repair_lfs failed:", err);
      toast.error(m.toast_error());
    } finally {
      setLfsRepairInFlight(false);
    }
  }, [projectPath, currentSpaceId, lfsRepairInFlight]);

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
        setAssetsStrategy(next);
        setSavedAssetsStrategy(next);
        if (next === "lfs-s3") {
          if (s3AccessKey.trim() && s3SecretKey.trim()) {
            setHasSavedS3Credentials(true);
            setS3AccessKey("");
            setS3SecretKey("");
          }
        } else {
          setHasSavedS3Credentials(false);
        }
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
      spacePath,
      s3Endpoint,
      s3Bucket,
      s3Region,
      s3AccessKey,
      s3SecretKey,
      projectPath,
      currentSpaceId,
      savedAssetsStrategy,
      loadLfsState,
    ],
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
    repairLfs: handleRepairLfs,
    cancelPendingStrategy,
    confirmPendingStrategy,
  };
}
