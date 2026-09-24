import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { GitUserPolicy } from "@/features/git";
import type { SpaceGitType, SpaceInfo } from "@/features/space";
import {
  getGitSubmoduleUrl,
  getSettingsGitUserPolicy,
  getSettingsGitRemote,
  getSettingsGitStatus,
  getSpaceGitType,
  listenGitCommitted,
  setSettingsGitUserPolicy,
  setGitRemote,
  type GitSetRemoteResult,
} from "../api";

interface UseSpaceSettingsGitOptions {
  open: boolean;
  spacePath: string;
  activeRootPath: string | null;
  isRoot: boolean;
  spaces: Pick<SpaceInfo, "id" | "path">[];
}

export type GitPolicyField = keyof GitUserPolicy;

export function useSpaceSettingsGit({
  open,
  spacePath,
  activeRootPath,
  isRoot,
  spaces,
}: UseSpaceSettingsGitOptions) {
  const [loaded, setLoaded] = useState(false);
  const [gitType, setGitType] = useState<SpaceGitType | null>(null);
  const [submoduleUrl, setSubmoduleUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [savedRemoteUrl, setSavedRemoteUrl] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(false);
  const [autoCommitStructural, setAutoCommitStructural] = useState(false);
  const [autoCommitSystem, setAutoCommitSystem] = useState(false);
  const [policyPending, setPolicyPending] = useState<
    ReadonlySet<GitPolicyField>
  >(() => new Set());
  const [pendingRemote, setPendingRemote] = useState<string | null>(null);
  const [applyingRemote, setApplyingRemote] = useState(false);
  const [remoteUpdateResult, setRemoteUpdateResult] =
    useState<GitSetRemoteResult | null>(null);
  const gitPolicyRef = useRef<GitUserPolicy>({
    autoSync: false,
    autoCommitStructural: false,
    autoCommitSystem: false,
  });
  const gitInfoGenerationRef = useRef(0);

  const applyGitPolicyState = useCallback((policy: GitUserPolicy) => {
    gitPolicyRef.current = policy;
    setAutoSync(policy.autoSync);
    setAutoCommitStructural(policy.autoCommitStructural);
    setAutoCommitSystem(policy.autoCommitSystem);
  }, []);

  const loadGitConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const policy = await getSettingsGitUserPolicy({
        spacePath,
        projectPath: activeRootPath,
      });
      applyGitPolicyState(policy);
    } catch (err) {
      console.error("Failed to load git config:", err);
    }
  }, [activeRootPath, applyGitPolicyState, spacePath]);

  // A reload after a commit keeps the shown values until the new ones arrive,
  // so the owner's summary and fields do not flash empty.
  const loadGitInfo = useCallback(async () => {
    if (!spacePath) return;
    const generation = ++gitInfoGenerationRef.current;
    setRemoteUpdateResult(null);

    const remotePromise = getSettingsGitRemote(spacePath).catch(() => null);
    const statusPromise = getSettingsGitStatus(spacePath).catch(() => null);
    let nextGitType: SpaceGitType | null = null;
    let nextSubmoduleUrl: string | null = null;

    if (!isRoot && activeRootPath) {
      try {
        nextGitType = await getSpaceGitType({
          projectPath: activeRootPath,
          spacePath,
        });
        if (nextGitType === "submodule") {
          const folder = spacePath.split("/").pop() ?? "";
          nextSubmoduleUrl = await getGitSubmoduleUrl({
            projectPath: activeRootPath,
            spaceFolder: folder,
          });
        }
      } catch {
        nextGitType = null;
      }
    }

    const [remote, status] = await Promise.all([remotePromise, statusPromise]);
    if (gitInfoGenerationRef.current !== generation) return;

    setGitType(nextGitType);
    setSubmoduleUrl(nextSubmoduleUrl);
    setRemoteUrl(remote ?? "");
    setSavedRemoteUrl(remote ?? "");
    setBranch(
      status?.branch && status.branch !== "HEAD" ? status.branch : null,
    );
  }, [spacePath, isRoot, activeRootPath]);

  useEffect(() => {
    if (!open || !spacePath) return;
    let cancelled = false;
    const preload = window.setTimeout(() => {
      void Promise.all([loadGitConfig(), loadGitInfo()]).then(() => {
        if (!cancelled) setLoaded(true);
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(preload);
      gitInfoGenerationRef.current += 1;
    };
  }, [open, spacePath, loadGitConfig, loadGitInfo]);

  useEffect(() => {
    if (!open || !spacePath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listenGitCommitted((event) => {
      if (cancelled) return;
      if (event.payload.spacePath !== spacePath) return;
      void loadGitInfo();
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [open, spacePath, loadGitInfo]);

  async function applyRemote(newUrl: string) {
    setApplyingRemote(true);
    try {
      const space = spaces.find((candidate) => candidate.path === spacePath);
      const result = await setGitRemote({
        spacePath,
        url: newUrl,
        projectPath: activeRootPath ?? null,
        spaceId: space?.id ?? null,
      });
      setSavedRemoteUrl(newUrl);
      setRemoteUrl(newUrl);
      setRemoteUpdateResult(result);
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("Failed to set remote:", err);
      toast.error(m.toast_error());
      setRemoteUrl(savedRemoteUrl);
    } finally {
      setApplyingRemote(false);
    }
  }

  function handleRemoteBlur() {
    if (applyingRemote) return;
    const next = remoteUrl.trim();
    if (next === savedRemoteUrl) return;
    if (next === "") {
      setRemoteUrl(savedRemoteUrl);
      return;
    }
    setPendingRemote(next);
  }

  function handleRemoteChange(value: string) {
    setRemoteUpdateResult(null);
    setRemoteUrl(value);
  }

  // Each switch applies at once; the field stays pending until its write ends.
  async function handlePolicyChange(field: GitPolicyField, value: boolean) {
    const previous = gitPolicyRef.current;
    const next: GitUserPolicy = { ...previous, [field]: value };
    applyGitPolicyState(next);
    setPolicyPending((current) => new Set(current).add(field));
    try {
      await setSettingsGitUserPolicy({
        spacePath,
        projectPath: activeRootPath,
        policy: next,
      });
    } catch (err) {
      console.error(`Failed to save git ${field} policy:`, err);
      if (gitPolicyRef.current === next) {
        applyGitPolicyState(previous);
      }
      toast.error(m.toast_error());
    } finally {
      setPolicyPending((current) => {
        const rest = new Set(current);
        rest.delete(field);
        return rest;
      });
    }
  }

  function cancelPendingRemote() {
    setPendingRemote(null);
    setRemoteUrl(savedRemoteUrl);
  }

  async function confirmPendingRemote() {
    const target = pendingRemote;
    setPendingRemote(null);
    if (target) await applyRemote(target);
  }

  return {
    loaded,
    gitType,
    submoduleUrl,
    remoteUrl,
    savedRemoteUrl,
    branch,
    autoSync,
    autoCommitStructural,
    autoCommitSystem,
    policyPending,
    pendingRemote,
    applyingRemote,
    remoteUpdateResult,
    setRemoteUrl: handleRemoteChange,
    handleRemoteBlur,
    handlePolicyChange,
    cancelPendingRemote,
    confirmPendingRemote,
  };
}

export type SpaceSettingsGit = ReturnType<typeof useSpaceSettingsGit>;
