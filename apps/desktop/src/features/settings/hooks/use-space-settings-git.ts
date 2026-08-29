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

export function useSpaceSettingsGit({
  open,
  spacePath,
  activeRootPath,
  isRoot,
  spaces,
}: UseSpaceSettingsGitOptions) {
  const [gitType, setGitType] = useState<SpaceGitType | null>(null);
  const [submoduleUrl, setSubmoduleUrl] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [savedRemoteUrl, setSavedRemoteUrl] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(false);
  const [autoCommitStructural, setAutoCommitStructural] = useState(false);
  const [autoCommitSystem, setAutoCommitSystem] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<string | null>(null);
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

  const loadGitInfo = useCallback(async () => {
    if (!spacePath) return;
    const generation = ++gitInfoGenerationRef.current;
    setGitType(null);
    setRemoteUrl("");
    setSavedRemoteUrl("");
    setBranch(null);
    setSubmoduleUrl(null);
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
    const preload = window.setTimeout(() => {
      void loadGitConfig();
      void loadGitInfo();
    }, 0);
    return () => {
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
    }
  }

  function handleRemoteBlur() {
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

  async function handleAutoSyncChange(value: boolean) {
    const previous = gitPolicyRef.current;
    const next = { ...previous, autoSync: value };
    gitPolicyRef.current = next;
    setAutoSync(next.autoSync);
    try {
      await setSettingsGitUserPolicy({
        spacePath,
        projectPath: activeRootPath,
        policy: next,
      });
    } catch (err) {
      console.error("Failed to save git auto-sync policy:", err);
      if (gitPolicyRef.current === next) {
        applyGitPolicyState(previous);
      }
      toast.error(m.toast_error());
    }
  }

  async function handleAutoCommitStructuralChange(value: boolean) {
    const previous = gitPolicyRef.current;
    const next = { ...previous, autoCommitStructural: value };
    gitPolicyRef.current = next;
    setAutoCommitStructural(next.autoCommitStructural);
    try {
      await setSettingsGitUserPolicy({
        spacePath,
        projectPath: activeRootPath,
        policy: next,
      });
    } catch (err) {
      console.error("Failed to save git structural autocommit policy:", err);
      if (gitPolicyRef.current === next) {
        applyGitPolicyState(previous);
      }
      toast.error(m.toast_error());
    }
  }

  async function handleAutoCommitSystemChange(value: boolean) {
    const previous = gitPolicyRef.current;
    const next = { ...previous, autoCommitSystem: value };
    gitPolicyRef.current = next;
    setAutoCommitSystem(next.autoCommitSystem);
    try {
      await setSettingsGitUserPolicy({
        spacePath,
        projectPath: activeRootPath,
        policy: next,
      });
    } catch (err) {
      console.error("Failed to save git system autocommit policy:", err);
      if (gitPolicyRef.current === next) {
        applyGitPolicyState(previous);
      }
      toast.error(m.toast_error());
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
    gitType,
    submoduleUrl,
    remoteUrl,
    branch,
    autoSync,
    autoCommitStructural,
    autoCommitSystem,
    pendingRemote,
    remoteUpdateResult,
    setRemoteUrl: handleRemoteChange,
    handleRemoteBlur,
    handleAutoSyncChange,
    handleAutoCommitStructuralChange,
    handleAutoCommitSystemChange,
    cancelPendingRemote,
    confirmPendingRemote,
  };
}
