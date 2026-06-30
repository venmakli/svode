import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getGitOutgoingCommits,
  getGitSyncWidgetConfig,
  listenGitSyncCommits,
  refreshGitSyncRemoteStatus,
  setGitAutoSync,
  syncGitNow,
} from "../api/git-sync-widget-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import { useGitStore, type GitStatus, type GitUnpushedCommit } from "../model";
import { selectActiveSpacePath, useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";

export interface GitSyncWidget {
  visible: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  branch: string;
  incoming: number | null;
  outgoing: number | null;
  remoteChecked: boolean;
  checkingRemote: boolean;
  syncError: string | null;
  syncing: boolean;
  autoSync: boolean;
  savingAutoSync: boolean;
  commits: GitUnpushedCommit[];
  loadingCommits: boolean;
  openDialog: () => Promise<void>;
  syncNow: () => Promise<void>;
  setAutoSync: (enabled: boolean) => Promise<void>;
}

export function useGitSyncWidget(): GitSyncWidget {
  const spacePath = useSpace(selectActiveSpacePath);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const status = useGitStore((state) =>
    spacePath ? state.statuses[spacePath] : undefined,
  );
  const syncing = useGitStore((state) =>
    spacePath ? state.syncing[spacePath] === true : false,
  );
  const syncError = useGitStore((state) =>
    spacePath ? (state.syncError[spacePath] ?? null) : null,
  );

  const [hasRemote, setHasRemote] = useState(false);
  const [autoSync, setAutoSyncState] = useState(false);
  const [open, setOpen] = useState(false);
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [checkingRemote, setCheckingRemote] = useState(false);
  const [commits, setCommits] = useState<GitUnpushedCommit[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [savingAutoSync, setSavingAutoSync] = useState(false);

  const refreshRemote = useCallback(async () => {
    if (!spacePath) return null;
    setCheckingRemote(true);
    try {
      const next = await refreshGitSyncRemoteStatus(spacePath);
      setRemoteChecked(true);
      return next;
    } catch (err) {
      console.debug("git fetch/status failed:", err);
      setRemoteChecked(false);
      return null;
    } finally {
      setCheckingRemote(false);
    }
  }, [spacePath]);

  const loadConfig = useCallback(async () => {
    if (!spacePath) {
      setHasRemote(false);
      setAutoSyncState(false);
      setRemoteChecked(false);
      setCommits([]);
      return;
    }

    try {
      const config = await getGitSyncWidgetConfig(spacePath, activeRootPath);
      setHasRemote(config.hasRemote);
      setAutoSyncState(config.autoSync);
      if (config.hasRemote) {
        await refreshRemote();
      } else {
        setRemoteChecked(false);
        setCommits([]);
      }
    } catch (err) {
      console.debug("git sync widget config failed:", err);
      setHasRemote(false);
      setAutoSyncState(false);
      setRemoteChecked(false);
      setCommits([]);
    }
  }, [activeRootPath, refreshRemote, spacePath]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!spacePath) return;

    let unlistenCommit: (() => void) | null = null;
    let cancelled = false;

    listenGitSyncCommits((committedSpacePath) => {
      if (cancelled) return;
      if (committedSpacePath !== spacePath) return;
      void refreshRemote();
      if (open) {
        void loadOutgoingCommits(spacePath, setCommits, setLoadingCommits);
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenCommit = unlisten;
    });

    return () => {
      cancelled = true;
      if (unlistenCommit) unlistenCommit();
    };
  }, [open, refreshRemote, spacePath]);

  const openDialog = useCallback(async () => {
    if (!spacePath) return;

    setOpen(true);
    const freshStatus = await refreshRemote();
    if (!freshStatus) {
      setCommits([]);
      return;
    }
    await loadOutgoingCommits(spacePath, setCommits, setLoadingCommits);
  }, [refreshRemote, spacePath]);

  const syncNow = useCallback(async () => {
    if (!spacePath) return;

    const outcome = await syncGitNow(spacePath);
    notifyGitSyncOutcome(outcome);
    if (outcome.type === "Success") {
      toast.success(m.git_sync_success());
      setOpen(false);
      setCommits([]);
      await refreshRemote();
    }
  }, [refreshRemote, spacePath]);

  const setAutoSync = useCallback(
    async (enabled: boolean) => {
      if (!spacePath) return;
      const previous = autoSync;
      setAutoSyncState(enabled);
      setSavingAutoSync(true);
      try {
        await setGitAutoSync({
          spacePath,
          projectPath: activeRootPath,
          enabled,
        });
      } catch (err) {
        console.error("Failed to update git auto-sync:", err);
        setAutoSyncState(previous);
        toast.error(m.toast_error());
      } finally {
        setSavingAutoSync(false);
      }
    },
    [activeRootPath, autoSync, spacePath],
  );

  const counters = useMemo(
    () => remoteCounters(status, remoteChecked),
    [remoteChecked, status],
  );

  return {
    visible: !!spacePath && hasRemote,
    open,
    setOpen,
    branch: branchLabel(status),
    incoming: counters.incoming,
    outgoing: counters.outgoing,
    remoteChecked,
    checkingRemote,
    syncError,
    syncing,
    autoSync,
    savingAutoSync,
    commits,
    loadingCommits,
    openDialog,
    syncNow,
    setAutoSync,
  };
}

function branchLabel(status: GitStatus | undefined): string {
  const branch = status?.branch?.trim();
  return branch && branch !== "HEAD" ? branch : "HEAD";
}

function remoteCounters(
  status: GitStatus | undefined,
  remoteChecked: boolean,
): { incoming: number | null; outgoing: number | null } {
  if (!remoteChecked) {
    return { incoming: null, outgoing: null };
  }
  return {
    incoming: status?.behind ?? 0,
    outgoing: status?.ahead ?? 0,
  };
}

async function loadOutgoingCommits(
  spacePath: string,
  setCommits: (commits: GitUnpushedCommit[]) => void,
  setLoadingCommits: (loading: boolean) => void,
): Promise<void> {
  setLoadingCommits(true);
  try {
    setCommits(await getGitOutgoingCommits(spacePath));
  } catch (err) {
    console.error("git_unpushed_commits failed:", err);
    setCommits([]);
  } finally {
    setLoadingCommits(false);
  }
}
