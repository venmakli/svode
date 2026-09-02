import { useCallback, useEffect, useMemo, useState } from "react";
import * as m from "@/paraglide/messages.js";
import type {
  AssetsS3Config,
  AssetsStrategy,
  BinaryRoutingConfig,
} from "@/features/space";
import { checkS3Connection, getAssetsConfig, hasS3Credentials } from "../api";
import {
  lfsRoutingDraftFromConfig,
  normalizeLfsRoutingDraft,
  sameBinaryRouting,
  storageTargetKey,
} from "../model/storage-strategy";

export type S3TestState = "idle" | "testing" | "ok" | "fail";

interface UseSpaceStorageConfigOptions {
  open: boolean;
  spacePath: string;
  projectPath: string;
  currentSpaceId: string | null;
}

export function useSpaceStorageConfig({
  open,
  spacePath,
  projectPath,
  currentSpaceId,
}: UseSpaceStorageConfigOptions) {
  const targetKey = storageTargetKey(projectPath, currentSpaceId);
  const [assetsStrategy, setAssetsStrategy] = useState<AssetsStrategy>("local");
  const [savedAssetsStrategy, setSavedAssetsStrategy] =
    useState<AssetsStrategy>("local");
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const [savedS3Config, setSavedS3Config] = useState<AssetsS3Config | null>(
    null,
  );
  const [inheritedFromProject, setInheritedFromProject] = useState(false);
  const [ownerSpaceId, setOwnerSpaceId] = useState<string | null>(null);
  const [defaultS3Prefix, setDefaultS3Prefix] = useState("");
  const [binaryRoutingStatus, setBinaryRoutingStatus] = useState<
    "legacy-preset" | "v1" | "unsupported"
  >("legacy-preset");
  const [binaryRoutingVersion, setBinaryRoutingVersion] = useState<
    number | null
  >(null);
  const [savedBinaryRouting, setSavedBinaryRouting] =
    useState<BinaryRoutingConfig | null>(null);
  const [lfsExtensions, setLfsExtensions] = useState("");
  const [lfsThresholdEnabled, setLfsThresholdEnabled] = useState(false);
  const [lfsThresholdMegabytes, setLfsThresholdMegabytes] = useState("10");
  const [s3Endpoint, setS3Endpoint] = useState("");
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3Region, setS3Region] = useState("");
  const [s3Prefix, setS3Prefix] = useState("");
  const [s3AccessKey, setS3AccessKey] = useState("");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [hasSavedS3Credentials, setHasSavedS3Credentials] = useState(false);
  const [s3TestState, setS3TestState] = useState<S3TestState>("idle");
  const [s3TestError, setS3TestError] = useState<string | null>(null);

  const canTestS3 =
    s3TestState !== "testing" &&
    Boolean(s3Endpoint.trim() && s3Bucket.trim() && s3Region.trim());
  const currentS3Config: AssetsS3Config | null = {
    endpoint: s3Endpoint.trim(),
    bucket: s3Bucket.trim(),
    region: s3Region.trim(),
    prefix: s3Prefix.trim(),
  };
  const canUseSavedS3Credentials =
    hasSavedS3Credentials && sameS3Connection(currentS3Config, savedS3Config);
  const canSaveS3 = Boolean(
    currentS3Config.endpoint &&
    currentS3Config.bucket &&
    currentS3Config.region &&
    currentS3Config.prefix &&
    (canUseSavedS3Credentials || (s3AccessKey.trim() && s3SecretKey.trim())),
  );
  const binaryRoutingDraft = useMemo(
    () =>
      normalizeLfsRoutingDraft({
        extensions: lfsExtensions,
        thresholdEnabled: lfsThresholdEnabled,
        thresholdMegabytes: lfsThresholdMegabytes,
      }),
    [lfsExtensions, lfsThresholdEnabled, lfsThresholdMegabytes],
  );
  const binaryRoutingChanged =
    binaryRoutingStatus === "legacy-preset" ||
    !sameBinaryRouting(binaryRoutingDraft.config, savedBinaryRouting);

  useEffect(() => {
    if (!open || !spacePath) return;
    let cancelled = false;

    const loadStorageConfig = async () => {
      const cfg = await getAssetsConfig({
        projectPath,
        spaceId: currentSpaceId,
      });
      const hasCredentials = await hasS3Credentials({
        projectPath,
        spaceId: currentSpaceId,
      }).catch(() => false);

      return {
        strategy: cfg.strategy,
        s3: cfg.s3,
        defaultS3Prefix: cfg.defaultS3Prefix,
        inheritedFromProject: cfg.inheritedFromProject,
        ownerSpaceId: cfg.ownerSpaceId,
        binaryRouting: cfg.binaryRouting,
        hasCredentials,
      };
    };

    void loadStorageConfig()
      .then(
        ({
          strategy,
          s3,
          defaultS3Prefix,
          inheritedFromProject,
          ownerSpaceId,
          binaryRouting,
          hasCredentials,
        }) => {
          if (cancelled) return;
          setAssetsStrategy(strategy);
          setSavedAssetsStrategy(strategy);
          setLoadedTargetKey(targetKey);
          setSavedS3Config(s3 ?? null);
          setDefaultS3Prefix(defaultS3Prefix);
          setInheritedFromProject(inheritedFromProject);
          setOwnerSpaceId(ownerSpaceId);
          setBinaryRoutingStatus(binaryRouting.status);
          setBinaryRoutingVersion(binaryRouting.version);
          const nextRouting: BinaryRoutingConfig | null =
            binaryRouting.status === "unsupported"
              ? null
              : {
                  version: 1,
                  lfsExtensions: [...binaryRouting.lfsExtensions].sort(),
                  lfsThresholdBytes: binaryRouting.lfsThresholdBytes,
                };
          const nextDraft = lfsRoutingDraftFromConfig(
            binaryRouting.lfsExtensions,
            binaryRouting.lfsThresholdBytes,
          );
          setSavedBinaryRouting(nextRouting);
          setLfsExtensions(nextDraft.extensions);
          setLfsThresholdEnabled(nextDraft.thresholdEnabled);
          setLfsThresholdMegabytes(nextDraft.thresholdMegabytes);
          setS3Endpoint(s3?.endpoint ?? "");
          setS3Bucket(s3?.bucket ?? "");
          setS3Region(s3?.region ?? "");
          setS3Prefix(s3?.prefix?.trim() || defaultS3Prefix);
          setS3AccessKey("");
          setS3SecretKey("");
          setS3TestState("idle");
          setS3TestError(null);
          setHasSavedS3Credentials(hasCredentials);
        },
      )
      .catch((err) => {
        console.error("Failed to load storage settings:", err);
        if (!cancelled) setLoadedTargetKey(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, spacePath, projectPath, currentSpaceId, targetKey]);

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

  const markStrategyApplied = useCallback(
    (
      next: AssetsStrategy,
      nextS3Config: AssetsS3Config | null,
      nextBinaryRouting: BinaryRoutingConfig,
    ) => {
      const keepSavedCredentials =
        next === "lfs-s3" &&
        hasSavedS3Credentials &&
        sameS3Connection(nextS3Config, savedS3Config);
      setAssetsStrategy(next);
      setSavedAssetsStrategy(next);
      setSavedS3Config(nextS3Config);
      setBinaryRoutingStatus("v1");
      setBinaryRoutingVersion(1);
      setSavedBinaryRouting(nextBinaryRouting);
      const nextDraft = lfsRoutingDraftFromConfig(
        nextBinaryRouting.lfsExtensions,
        nextBinaryRouting.lfsThresholdBytes ?? null,
      );
      setLfsExtensions(nextDraft.extensions);
      setLfsThresholdEnabled(nextDraft.thresholdEnabled);
      setLfsThresholdMegabytes(nextDraft.thresholdMegabytes);
      if (next === "lfs-s3") {
        if (s3AccessKey.trim() && s3SecretKey.trim()) {
          setHasSavedS3Credentials(true);
          setS3AccessKey("");
          setS3SecretKey("");
        } else {
          setHasSavedS3Credentials(keepSavedCredentials);
        }
      } else {
        setHasSavedS3Credentials(false);
      }
    },
    [hasSavedS3Credentials, s3AccessKey, s3SecretKey, savedS3Config],
  );

  return {
    assetsStrategy,
    savedAssetsStrategy,
    loadedForCurrentTarget: loadedTargetKey === targetKey,
    savedS3Config,
    defaultS3Prefix,
    binaryRoutingStatus,
    binaryRoutingVersion,
    binaryRoutingConfig: binaryRoutingDraft.config,
    binaryRoutingIssue: binaryRoutingDraft.issue,
    binaryRoutingChanged,
    lfsExtensions,
    lfsThresholdEnabled,
    lfsThresholdMegabytes,
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
    setLfsExtensions,
    setLfsThresholdEnabled,
    setLfsThresholdMegabytes,
    setS3Endpoint,
    setS3Bucket,
    setS3Region,
    setS3Prefix,
    setS3AccessKey,
    setS3SecretKey,
    testS3,
    markStrategyApplied,
  };
}

function sameS3Connection(
  left: AssetsS3Config | null,
  right: AssetsS3Config | null,
) {
  return (
    left !== null &&
    right !== null &&
    left.endpoint === right.endpoint &&
    left.bucket === right.bucket &&
    left.region === right.region
  );
}
