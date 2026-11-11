import { useCallback, useEffect, useMemo, useState } from "react";
import type { AssetsS3Config, AssetsStrategy } from "@/features/space";
import { getAssetsConfig } from "../api";
import { useStorageS3 } from "./use-storage-s3";
import {
  binaryRoutingDraftForGroup,
  binaryRoutingDraftFromConfig,
  normalizeBinaryRoutingDraft,
  sameBinaryRouting,
  storageTargetKey,
  type BinaryRoutingDraft,
  type StorageBinaryRouting,
} from "../model/storage-strategy";

interface UseSpaceStorageConfigOptions {
  open: boolean;
  // The S3 pair loads only while the owner's details are open.
  detailsOpen: boolean;
  spacePath: string;
  projectPath: string;
  currentSpaceId: string | null;
}

export function useSpaceStorageConfig({
  open,
  detailsOpen,
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
  const [unknownStrategy, setUnknownStrategy] = useState(false);
  const [ownerSpaceId, setOwnerSpaceId] = useState<string | null>(null);
  const [defaultS3Prefix, setDefaultS3Prefix] = useState("");
  const [binaryRoutingStatus, setBinaryRoutingStatus] = useState<
    "legacy-preset" | "v1" | "unsupported"
  >("legacy-preset");
  const [binaryRoutingVersion, setBinaryRoutingVersion] = useState<
    number | null
  >(null);
  const [savedBinaryRouting, setSavedBinaryRouting] =
    useState<StorageBinaryRouting | null>(null);
  const [lfsExtensions, setLfsExtensions] = useState("");
  const [localExtensions, setLocalExtensions] = useState("");
  const [lfsThresholdEnabled, setLfsThresholdEnabled] = useState(false);
  const [lfsThresholdMegabytes, setLfsThresholdMegabytes] = useState("10");
  const [s3Endpoint, setS3Endpoint] = useState("");
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3Region, setS3Region] = useState("");
  const [s3Prefix, setS3Prefix] = useState("");
  const [loadError, setLoadError] = useState(false);
  const setDraft = useCallback((draft: BinaryRoutingDraft) => {
    setLfsExtensions(draft.lfsExtensions);
    setLocalExtensions(draft.localExtensions);
    setLfsThresholdEnabled(draft.thresholdEnabled);
    setLfsThresholdMegabytes(draft.thresholdMegabytes);
  }, []);
  const [reload, setReload] = useState(0);
  const s3 = useStorageS3({
    open: detailsOpen,
    projectPath,
    spaceId: currentSpaceId,
    target: {
      endpoint: s3Endpoint.trim(),
      bucket: s3Bucket.trim(),
      region: s3Region.trim(),
      prefix: s3Prefix.trim(),
    },
    enabled:
      loadedTargetKey === targetKey &&
      !inheritedFromProject &&
      !unknownStrategy,
  });
  // `local` is a strategy one only leaves, so its draft is never a step
  // toward another one: the local rules are edited only while it is chosen.
  const rulesGroup = assetsStrategy === "local" ? "local" : "lfs";
  const binaryRoutingDraft = useMemo(
    () =>
      normalizeBinaryRoutingDraft(
        binaryRoutingDraftForGroup(
          {
            lfsExtensions,
            localExtensions,
            thresholdEnabled: lfsThresholdEnabled,
            thresholdMegabytes: lfsThresholdMegabytes,
          },
          savedBinaryRouting,
          rulesGroup,
        ),
      ),
    [
      lfsExtensions,
      localExtensions,
      lfsThresholdEnabled,
      lfsThresholdMegabytes,
      savedBinaryRouting,
      rulesGroup,
    ],
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
      return {
        strategy: cfg.strategy,
        unknownStrategy: cfg.unknownStrategy,
        s3: cfg.s3,
        defaultS3Prefix: cfg.defaultS3Prefix,
        inheritedFromProject: cfg.inheritedFromProject,
        ownerSpaceId: cfg.ownerSpaceId,
        binaryRouting: cfg.binaryRouting,
      };
    };

    void loadStorageConfig()
      .then(
        ({
          strategy,
          unknownStrategy,
          s3,
          defaultS3Prefix,
          inheritedFromProject,
          ownerSpaceId,
          binaryRouting,
        }) => {
          if (cancelled) return;
          setLoadError(false);
          // A strategy of a newer Svode version is never shown or applied as
          // one of ours; the section shows why storage cannot change instead.
          const known = unknownStrategy ? "local" : strategy;
          setUnknownStrategy(unknownStrategy);
          setAssetsStrategy(known);
          setSavedAssetsStrategy(known);
          setLoadedTargetKey(targetKey);
          setSavedS3Config(s3 ?? null);
          setDefaultS3Prefix(defaultS3Prefix);
          setInheritedFromProject(inheritedFromProject);
          setOwnerSpaceId(ownerSpaceId);
          setBinaryRoutingStatus(binaryRouting.status);
          setBinaryRoutingVersion(binaryRouting.version);
          const nextRouting: StorageBinaryRouting | null =
            binaryRouting.status === "unsupported"
              ? null
              : {
                  version: 1,
                  lfsExtensions: [...binaryRouting.lfsExtensions].sort(),
                  lfsThresholdBytes: binaryRouting.lfsThresholdBytes,
                  localExtensions: [...binaryRouting.localExtensions].sort(),
                };
          setSavedBinaryRouting(nextRouting);
          setDraft(binaryRoutingDraftFromConfig(binaryRouting));
          setS3Endpoint(s3?.endpoint ?? "");
          setS3Bucket(s3?.bucket ?? "");
          setS3Region(s3?.region ?? "");
          setS3Prefix(s3?.prefix?.trim() || defaultS3Prefix);
        },
      )
      .catch((err) => {
        console.error("Failed to load storage settings:", err);
        if (!cancelled) {
          setLoadedTargetKey(null);
          setLoadError(true);
        }
      });

    return () => {
      cancelled = true;
      setLoadedTargetKey(null);
    };
  }, [
    open,
    spacePath,
    projectPath,
    currentSpaceId,
    targetKey,
    reload,
    setDraft,
  ]);

  const markStrategyApplied = useCallback(
    (
      next: AssetsStrategy,
      nextS3Config: AssetsS3Config | null,
      nextBinaryRouting: StorageBinaryRouting,
    ) => {
      setAssetsStrategy(next);
      setSavedAssetsStrategy(next);
      setSavedS3Config(nextS3Config);
      setBinaryRoutingStatus("v1");
      setBinaryRoutingVersion(1);
      setSavedBinaryRouting(nextBinaryRouting);
      setDraft(binaryRoutingDraftFromConfig(nextBinaryRouting));
    },
    [setDraft],
  );

  return {
    s3,
    loadError,
    retryLoad: () => setReload((value) => value + 1),
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
    localExtensions,
    lfsThresholdEnabled,
    lfsThresholdMegabytes,
    inheritedFromProject,
    unknownStrategy,
    ownerSpaceId,
    s3Endpoint,
    s3Bucket,
    s3Region,
    s3Prefix,
    setAssetsStrategy,
    setLfsExtensions,
    setLocalExtensions,
    setLfsThresholdEnabled,
    setLfsThresholdMegabytes,
    setS3Endpoint,
    setS3Bucket,
    setS3Region,
    setS3Prefix,
    markStrategyApplied,
  };
}
