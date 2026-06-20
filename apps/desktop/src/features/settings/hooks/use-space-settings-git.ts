import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import type { SpaceGitType, SpaceInfo } from "@/features/space";
import {
  getGitSubmoduleUrl,
  getSettingsGitRemote,
  getSettingsGitStatus,
  getSettingsSpaceConfig,
  getSpaceGitType,
  listenGitCommitted,
  setGitRemote,
} from "../api";
import type { SaveSpaceGitConfig } from "./use-space-settings-config-actions";

interface UseSpaceSettingsGitOptions {
  open: boolean;
  spacePath: string;
  activeRootPath: string | null;
  isRoot: boolean;
  spaces: Pick<SpaceInfo, "id" | "path">[];
  saveGitConfig: SaveSpaceGitConfig;
}

export function useSpaceSettingsGit({
  open,
  spacePath,
  activeRootPath,
  isRoot,
  spaces,
  saveGitConfig,
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

  const loadGitConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      setAutoSync(cfg.git?.autoSync === true);
      setAutoCommitStructural(cfg.git?.autoCommitStructural === true);
      setAutoCommitSystem(cfg.git?.autoCommitSystem === true);
    } catch (err) {
      console.error("Failed to load git config:", err);
    }
  }, [spacePath]);

  const loadGitInfo = useCallback(async () => {
    if (!spacePath) return;
    setRemoteUrl("");
    setSavedRemoteUrl("");
    setBranch(null);
    setSubmoduleUrl(null);

    if (!isRoot && activeRootPath) {
      try {
        const type = await getSpaceGitType({
          projectPath: activeRootPath,
          spacePath,
        });
        setGitType(type);
        if (type === "submodule") {
          const folder = spacePath.split("/").pop() ?? "";
          const url = await getGitSubmoduleUrl({
            projectPath: activeRootPath,
            spaceFolder: folder,
          });
          setSubmoduleUrl(url);
        }
      } catch {
        setGitType(null);
      }
    } else {
      setGitType(null);
    }

    try {
      const remote = await getSettingsGitRemote(spacePath);
      setRemoteUrl(remote ?? "");
      setSavedRemoteUrl(remote ?? "");
    } catch {
      setRemoteUrl("");
      setSavedRemoteUrl("");
    }

    try {
      const status = await getSettingsGitStatus(spacePath);
      setBranch(
        status.branch && status.branch !== "HEAD" ? status.branch : null,
      );
    } catch {
      setBranch(null);
    }
  }, [spacePath, isRoot, activeRootPath]);

  useEffect(() => {
    if (!open || !spacePath) return;
    const preload = window.setTimeout(() => {
      void loadGitConfig();
      void loadGitInfo();
    }, 0);
    return () => window.clearTimeout(preload);
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
      await setGitRemote({
        spacePath,
        url: newUrl,
        projectPath: activeRootPath ?? null,
        spaceId: space?.id ?? null,
      });
      setSavedRemoteUrl(newUrl);
      setRemoteUrl(newUrl);
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

  async function handleAutoSyncChange(value: boolean) {
    setAutoSync(value);
    await saveGitConfig({ autoSync: value });
  }

  async function handleAutoCommitStructuralChange(value: boolean) {
    setAutoCommitStructural(value);
    await saveGitConfig({ autoCommitStructural: value });
  }

  async function handleAutoCommitSystemChange(value: boolean) {
    setAutoCommitSystem(value);
    await saveGitConfig({ autoCommitSystem: value });
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
    setRemoteUrl,
    handleRemoteBlur,
    handleAutoSyncChange,
    handleAutoCommitStructuralChange,
    handleAutoCommitSystemChange,
    cancelPendingRemote,
    confirmPendingRemote,
  };
}
