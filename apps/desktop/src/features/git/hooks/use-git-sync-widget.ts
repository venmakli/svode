import { useParentPublication } from "./use-parent-publication";
import { isFullSyncSuccess } from "../model/publication";
import { refreshGitPublication } from "../api/git-publication-actions";
import { refreshGitSyncStop } from "../api/git-sync-stop-actions";
import { gitSyncErrorMessage } from "../api/git-sync-error";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { toast } from "sonner";
import {
  getGitLastSyncedAt,
  getGitOutgoingCommits,
  getGitSyncWidgetConfig,
  listenGitSyncCommits,
  refreshGitSyncRemoteStatus,
  saveGitSyncCredentials,
  syncGitNow,
} from "../api/git-sync-widget-actions";
import { refreshGitOnWindowFocus } from "../api/git-focus-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import {
  useGitStore,
  type GitAuthChallenge,
  type GitPublicationBlock,
  type GitRemoteAuthCredentials,
  type GitStatus,
  type GitSyncMerged,
  type GitSyncOutcome,
  type GitSyncStop,
  type GitUnpushedCommit,
} from "../model";
import { selectActiveSpacePath, useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";

export interface GitSyncWidget {
  parent: ReturnType<typeof useParentPublication>;
  spacePath: string;
  /** The repository the conflict file paths are relative to. */
  repositoryPath: string;
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
  stop: GitSyncStop | null;
  /**
   * Svode service files the last sync merged, relative to the repository,
   * and the items it renumbered.
   */
  syncMerged: GitSyncMerged;
  /** Spaces that stopped the project publication; replaces the sync error. */
  publicationBlock: GitPublicationBlock | null;
  syncing: boolean;
  autoSync: boolean;
  /** When the repository last synced on this device, in Unix milliseconds. */
  lastSynced: number | null;
  /** The clock the time since the last sync is shown against. */
  now: number;
  commits: GitUnpushedCommit[];
  /** The list is being read for the shown counters. */
  loadingCommits: boolean;
  /** The list could not be read for the shown counters. */
  commitsFailed: boolean;
  /** Outgoing commits left out of the shown list, by the counter it was read for. */
  moreCommits: number;
  authOpen: boolean;
  authChallenge: GitAuthChallenge | null;
  authSaving: boolean;
  authError: string | null;
  openDialog: () => Promise<void>;
  /**
   * An explicit sync; resolves its outcome, or null when it did not run or
   * the Dialog moved to another repository meanwhile.
   */
  syncNow: () => Promise<GitSyncOutcome | null>;
  /** Ask for the remote sign-in of this repository. */
  requestAuth: (challenge: GitAuthChallenge) => void;
  /** Finish the Dialog like a successful sync. */
  closeAfterSync: () => void;
  setAuthOpen: (open: boolean) => void;
  saveAuthAndRetry: (credentials: GitRemoteAuthCredentials) => Promise<void>;
}

/** The outgoing commits read for one remote status of the repository. */
interface OutgoingList {
  status: GitStatus;
  commits: GitUnpushedCommit[];
  failed: boolean;
}

/** Git sync of the repository at `spacePath`, which need not be the active Space. */
export function useGitSyncWidget(spacePath: string): GitSyncWidget {
  const parent = useParentPublication(spacePath);
  const active = useRef<object | null>(null);
  const remoteRequest = useRef(0);
  const configRequest = useRef(0);
  useEffect(() => {
    active.current = {};
    remoteRequest.current++;
    configRequest.current++;
    setHasRemote(false);
    setAutoSyncState(false);
    setOpen(false);
    setAuthOpenState(false);
    setAuthSaving(false);
    setAuthChallenge(null);
    setAuthError(null);
    setOutgoingList(null);
    setCheckingRemote(false);
    return () => {
      active.current = null;
    };
  }, [spacePath]);
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const activeSpacePath = useSpace(selectActiveSpacePath);
  // The app refreshes the active Space on focus once (`useAppGitFocus`);
  // another repository shown here refreshes the same way.
  useEffect(() => {
    if (!spacePath || spacePath === activeSpacePath) return;
    const onFocus = () => void refreshGitOnWindowFocus(spacePath);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeSpacePath, spacePath]);
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
  const stop = useGitStore((state) =>
    repository ? (state.syncStop[repository] ?? null) : null,
  );
  const publicationBlock = useGitStore((state) =>
    repository ? (state.publicationBlock[repository] ?? null) : null,
  );
  const syncMerged = useGitStore((state) =>
    repository
      ? (state.syncMerged[repository] ?? NOTHING_MERGED)
      : NOTHING_MERGED,
  );
  const lastSynced = useGitStore((state) =>
    repository ? (state.lastSynced[repository] ?? null) : null,
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
  const [outgoingList, setOutgoingList] = useState<OutgoingList | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
      setOutgoingList(null);
      return;
    }

    try {
      const config = await getGitSyncWidgetConfig(spacePath, activeRootPath);
      if (active.current !== identity || configRequest.current !== request)
        return;
      setHasRemote(config.hasRemote);
      setAutoSyncState(config.autoSync);
      if (config.hasRemote) {
        void getGitLastSyncedAt(spacePath).catch(() => {});
        await refreshRemote();
      } else {
        setOutgoingList(null);
      }
    } catch (err) {
      if (active.current !== identity || configRequest.current !== request)
        return;
      console.debug("git sync widget config failed:", err);
      setHasRemote(false);
      setAutoSyncState(false);
      setOutgoingList(null);
    }
  }, [activeRootPath, refreshRemote, spacePath]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const refreshStop = useCallback(() => {
    if (spacePath) void refreshGitSyncStop(spacePath).catch(() => {});
  }, [spacePath]);

  useEffect(refreshStop, [refreshStop]);

  // The list follows the counters: every new remote status of the shown
  // repository rereads it, whichever action wrote that status.
  useEffect(() => {
    if (!spacePath || !open || !remoteChecked || !remoteStatus) return;
    let current = true;
    getGitOutgoingCommits(spacePath).then(
      (commits) => {
        if (current)
          setOutgoingList({ status: remoteStatus, commits, failed: false });
      },
      (err) => {
        console.error("git_unpushed_commits failed:", err);
        if (current)
          setOutgoingList({ status: remoteStatus, commits: [], failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [open, remoteChecked, remoteStatus, spacePath]);

  useEffect(() => {
    if (!spacePath) return;

    let unlistenCommit: (() => void) | null = null;
    let cancelled = false;

    listenGitSyncCommits((committedSpacePath) => {
      if (cancelled) return;
      if (committedSpacePath !== spacePath) return;
      refreshStop();
      void refreshRemote();
      void refreshGitPublication(spacePath).catch(() => {});
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenCommit = unlisten;
    });

    return () => {
      cancelled = true;
      if (unlistenCommit) unlistenCommit();
    };
  }, [refreshRemote, refreshStop, spacePath]);

  // The time since the last sync stays current while the Dialog is open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const openDialog = useCallback(async () => {
    if (!spacePath) return;

    setOpen(true);
    refreshStop();
    void refreshGitPublication(spacePath).catch(() => {});
    // The sync toggle may have changed in the settings meanwhile.
    await loadConfig();
  }, [loadConfig, refreshStop, spacePath]);

  const requestAuth = useCallback((challenge: GitAuthChallenge) => {
    setAuthChallenge(challenge);
    setAuthError(null);
    setAuthOpenState(true);
  }, []);

  const closeAfterSync = useCallback(() => {
    setOpen(false);
    setOutgoingList(null);
  }, []);

  const syncNow = useCallback(async (): Promise<GitSyncOutcome | null> => {
    if (!spacePath) return null;
    const identity = active.current;

    const outcome = await syncGitNow(spacePath);
    if (active.current !== identity) return null;
    if (outcome.type === "AuthRequired") {
      if (outcome.challenge) requestAuth(outcome.challenge);
      else notifyGitSyncOutcome(outcome);
      return outcome;
    }
    notifyGitSyncOutcome(outcome);
    if (isFullSyncSuccess(outcome)) {
      toast.success(m.git_sync_success());
      closeAfterSync();
    }
    return outcome;
  }, [closeAfterSync, requestAuth, spacePath]);

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
          toast.success(m.git_sync_success());
          setAuthOpenState(false);
          setAuthChallenge(null);
          closeAfterSync();
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
    [authChallenge, authSaving, closeAfterSync, spacePath],
  );

  const counters = useMemo(
    () => remoteCounters(remoteStatus, remoteChecked),
    [remoteChecked, remoteStatus],
  );
  // Until the list of the shown counters arrives, the previous one stays.
  const listCurrent = !!outgoingList && outgoingList.status === remoteStatus;

  return {
    parent,
    spacePath,
    repositoryPath: repository,
    visible:
      !!spacePath &&
      (hasRemote ||
        !!syncError ||
        !!remoteError ||
        !!stop ||
        !!publicationBlock ||
        !!parent.publication),
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
    stop,
    syncMerged,
    publicationBlock,
    syncing,
    autoSync,
    lastSynced,
    now,
    commits: outgoingList?.commits ?? [],
    loadingCommits: open && remoteChecked && !listCurrent,
    commitsFailed: listCurrent && outgoingList?.failed === true,
    moreCommits:
      outgoingList && !outgoingList.failed
        ? Math.max(0, outgoingList.status.ahead - outgoingList.commits.length)
        : 0,
    authOpen,
    authChallenge,
    authSaving,
    authError,
    openDialog,
    syncNow,
    requestAuth,
    closeAfterSync,
    setAuthOpen,
    saveAuthAndRetry,
  };
}

const NOTHING_MERGED: GitSyncMerged = { files: [], renumbered: [] };

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
