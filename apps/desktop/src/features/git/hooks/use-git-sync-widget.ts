import { useParentPublication } from "./use-parent-publication";
import { isFullSyncSuccess } from "../model/publication";
import { refreshGitPublication } from "../api/git-publication-actions";
import { gitSyncErrorMessage } from "../api/git-sync-error";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { toast } from "sonner";
import {
  getGitOutgoingCommits,
  getGitSyncWidgetConfig,
  listenGitSyncCommits,
  refreshGitSyncRemoteStatus,
  saveGitSyncCredentials,
  setGitAutoSync,
  syncGitNow,
} from "../api/git-sync-widget-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import {
  useGitStore,
  type GitAuthChallenge,
  type GitRemoteAuthCredentials,
  type GitStatus,
  type GitUnpushedCommit,
} from "../model";
import { selectActiveSpacePath, useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";

export interface GitSyncWidget {
  parent: ReturnType<typeof useParentPublication>;
  spacePath: string;
  visible: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  branch: string;
  incoming: number | null;
  outgoing: number | null;
  remoteChecked: boolean;
  checkingRemote: boolean;
  syncError: string | null;
  remoteError: string | null;
  branchError: string | null;
  syncing: boolean;
  autoSync: boolean;
  savingAutoSync: boolean;
  commits: GitUnpushedCommit[];
  loadingCommits: boolean;
  authOpen: boolean;
  authChallenge: GitAuthChallenge | null;
  authSaving: boolean;
  authError: string | null;
  openDialog: () => Promise<void>;
  syncNow: () => Promise<void>;
  setAuthOpen: (open: boolean) => void;
  saveAuthAndRetry: (credentials: GitRemoteAuthCredentials) => Promise<void>;
  setAutoSync: (enabled: boolean) => Promise<void>;
}

export function useGitSyncWidget(): GitSyncWidget {
  const spacePath = useSpace(selectActiveSpacePath);
  const parent = useParentPublication(spacePath);
  const active = useRef<object | null>(null);
  const remoteRequest = useRef(0);
  const outgoingRequest = useRef(0);
  const configRequest = useRef(0);
  useEffect(() => {
    active.current = {};
    remoteRequest.current++;
    outgoingRequest.current++;
    configRequest.current++;
    setHasRemote(false);
    setAutoSyncState(false);
    setSavingAutoSync(false);
    setOpen(false);
    setAuthOpenState(false);
    setAuthSaving(false);
    setAuthChallenge(null);
    setAuthError(null);
    setCommits([]);
    setCheckingRemote(false);
    setLoadingCommits(false);
    return () => {
      active.current = null;
    };
  }, [spacePath]);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const status = useGitStore((state) =>
    spacePath ? state.statuses[spacePath] : undefined,
  );
  const repository = status?.repository ?? spacePath;
  const syncing = useGitStore(
    (state) =>
      !!spacePath &&
      (state.syncing[spacePath] === true ||
        (!!repository && state.backendSyncing[repository] === true)),
  );
  const branchError = useGitStore((state) =>
    repository ? (state.branchError[repository] ?? null) : null,
  );
  const syncError = useGitStore((state) =>
    repository
      ? (state.branchError[repository] ?? state.syncError[repository] ?? null)
      : null,
  );
  const remoteError = useGitStore((state) =>
    repository ? (state.remoteError[repository] ?? null) : null,
  );

  const [hasRemote, setHasRemote] = useState(false);
  const [autoSync, setAutoSyncState] = useState(false);
  const [open, setOpen] = useState(false);
  const remoteChecked = useGitStore(
    (state) => !!repository && state.remoteChecked[repository] === true,
  );
  const remoteStatus = useGitStore((state) =>
    repository ? state.remoteStatuses[repository] : undefined,
  );
  const [checkingRemote, setCheckingRemote] = useState(false);
  const [commits, setCommits] = useState<GitUnpushedCommit[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [savingAutoSync, setSavingAutoSync] = useState(false);
  const [authOpen, setAuthOpenState] = useState(false);
  const [authChallenge, setAuthChallenge] = useState<GitAuthChallenge | null>(
    null,
  );
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshRemote = useCallback(async () => {
    if (!spacePath) return null;
    const identity = active.current;
    const request = ++remoteRequest.current;
    setCheckingRemote(true);
    try {
      const next = await refreshGitSyncRemoteStatus(spacePath);
      if (active.current !== identity) return null;
      return next;
    } catch (err) {
      console.debug("git fetch/status failed:", err);
      return null;
    } finally {
      if (active.current === identity && remoteRequest.current === request)
        setCheckingRemote(false);
    }
  }, [spacePath]);

  const loadConfig = useCallback(async () => {
    const identity = active.current;
    const request = ++configRequest.current;
    if (!spacePath) {
      setHasRemote(false);
      setAutoSyncState(false);
      setCommits([]);
      return;
    }

    try {
      const config = await getGitSyncWidgetConfig(spacePath, activeRootPath);
      if (active.current !== identity || configRequest.current !== request)
        return;
      setHasRemote(config.hasRemote);
      setAutoSyncState(config.autoSync);
      if (config.hasRemote) {
        await refreshRemote();
      } else {
        setCommits([]);
      }
    } catch (err) {
      if (active.current !== identity || configRequest.current !== request)
        return;
      console.debug("git sync widget config failed:", err);
      setHasRemote(false);
      setAutoSyncState(false);
      setCommits([]);
    }
  }, [activeRootPath, refreshRemote, spacePath]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadCommits = useCallback(async () => {
    if (!spacePath) return;
    const identity = active.current;
    const request = ++outgoingRequest.current;
    const current = () =>
      active.current === identity && outgoingRequest.current === request;
    await loadOutgoingCommits(
      spacePath,
      (value) => {
        if (current()) setCommits(value);
      },
      (value) => {
        if (current()) setLoadingCommits(value);
      },
    );
  }, [spacePath]);

  useEffect(() => {
    if (!spacePath) return;

    let unlistenCommit: (() => void) | null = null;
    let cancelled = false;

    listenGitSyncCommits((committedSpacePath) => {
      if (cancelled) return;
      if (committedSpacePath !== spacePath) return;
      void refreshRemote();
      void refreshGitPublication(spacePath).catch(() => {});
      if (open) {
        void loadCommits();
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenCommit = unlisten;
    });

    return () => {
      cancelled = true;
      if (unlistenCommit) unlistenCommit();
    };
  }, [loadCommits, open, refreshRemote, spacePath]);

  const openDialog = useCallback(async () => {
    if (!spacePath) return;
    const identity = active.current;

    setOpen(true);
    void refreshGitPublication(spacePath).catch(() => {});
    const freshStatus = await refreshRemote();
    if (active.current !== identity) return;
    if (!freshStatus) {
      setCommits([]);
      return;
    }
    await loadCommits();
  }, [loadCommits, refreshRemote, spacePath]);

  const syncNow = useCallback(async () => {
    if (!spacePath) return;
    const identity = active.current;

    const outcome = await syncGitNow(spacePath);
    if (active.current !== identity) return;
    if (outcome.type === "AuthRequired") {
      if (outcome.challenge) {
        setAuthChallenge(outcome.challenge);
        setAuthError(null);
        setAuthOpenState(true);
      } else {
        notifyGitSyncOutcome(outcome);
      }
      return;
    }
    notifyGitSyncOutcome(outcome);
    if (isFullSyncSuccess(outcome)) {
      outgoingRequest.current++;
      toast.success(m.git_sync_success());
      setOpen(false);
      setCommits([]);
    }
  }, [spacePath]);

  const setAuthOpen = useCallback((nextOpen: boolean) => {
    setAuthOpenState(nextOpen);
    if (!nextOpen) {
      setAuthError(null);
    }
  }, []);

  const saveAuthAndRetry = useCallback(
    async (credentials: GitRemoteAuthCredentials) => {
      if (!spacePath || !authChallenge?.remoteUrl || authSaving) return;

      const identity = active.current;
      setAuthSaving(true);
      setAuthError(null);
      try {
        await saveGitSyncCredentials({
          remoteUrl: authChallenge.remoteUrl,
          username: credentials.username,
          password: credentials.password,
        });
        if (active.current !== identity) return;
        const outcome = await syncGitNow(spacePath);
        if (active.current !== identity) return;
        if (isFullSyncSuccess(outcome)) {
          outgoingRequest.current++;
          toast.success(m.git_sync_success());
          setAuthOpenState(false);
          setAuthChallenge(null);
          setOpen(false);
          setCommits([]);
          return;
        }
        if (outcome.type === "AuthRequired") {
          setAuthChallenge(outcome.challenge ?? authChallenge);
          setAuthError(m.git_remote_auth_invalid_error());
          return;
        }
        notifyGitSyncOutcome(outcome);
        setAuthOpenState(false);
        setAuthChallenge(null);
      } catch (err) {
        console.error("git credential save/retry failed:", err);
        if (active.current === identity)
          setAuthError(m.git_remote_auth_save_failed());
      } finally {
        if (active.current === identity) setAuthSaving(false);
      }
    },
    [authChallenge, authSaving, spacePath],
  );

  const setAutoSync = useCallback(
    async (enabled: boolean) => {
      if (!spacePath) return;
      const identity = active.current;
      configRequest.current++;
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
        if (active.current !== identity) return;
        setAutoSyncState(previous);
        toast.error(m.toast_error());
      } finally {
        if (active.current === identity) setSavingAutoSync(false);
      }
    },
    [activeRootPath, autoSync, spacePath],
  );

  const counters = useMemo(
    () => remoteCounters(remoteStatus, remoteChecked),
    [remoteChecked, remoteStatus],
  );

  return {
    parent,
    spacePath,
    visible:
      !!spacePath &&
      (hasRemote || !!syncError || !!remoteError || !!parent.publication),
    open,
    setOpen,
    branch: branchLabel(status),
    incoming: counters.incoming,
    outgoing: counters.outgoing,
    remoteChecked,
    checkingRemote,
    syncError: syncError ? gitSyncErrorMessage(syncError) : null,
    remoteError,
    branchError,
    syncing,
    autoSync,
    savingAutoSync,
    commits,
    loadingCommits,
    authOpen,
    authChallenge,
    authSaving,
    authError,
    openDialog,
    syncNow,
    setAuthOpen,
    saveAuthAndRetry,
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
