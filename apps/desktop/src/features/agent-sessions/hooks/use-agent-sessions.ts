import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hotStatusAgentSessions,
  listAgentSessions,
  openSessionCwdInExternalTerminal,
  reenterAgentSession,
  refreshAgentSessions,
  setAgentSessionPinned,
  type AgentSessionReentryResult,
  type AgentSessionsListResult,
} from "../api";
import {
  DEFAULT_SPACE_GROUP_LIMIT,
  applyLocalTerminalRuntime,
  buildAgentSessionGroups,
  buildHotStatusSessionIds,
  buildPendingAgentSession,
  findMatchingSessionForPendingTerminal,
  isPendingSessionId,
  pendingSessionId,
  type AgentSession,
  type AgentSessionGroupingResult,
  type AgentSessionSelectionSource,
  type AgentSessionScopeGroup,
  type PendingAgentSessionTerminal,
} from "../model";
import {
  closeManagedTerminalSurface,
  spawnManagedTerminalSurface,
} from "@/features/terminal/session-surface";
import { getNativeErrorMessage } from "@/platform/native/errors";
import * as m from "@/paraglide/messages.js";

const POLL_INTERVAL_MS = 45_000;
const HOT_STATUS_POLL_INTERVAL_MS = 1_500;
const HIDDEN_HOT_STATUS_POLL_INTERVAL_MS = 15_000;
const PENDING_POLL_INTERVAL_MS = 5_000;

interface SelectedTerminalState {
  ptyId: string;
  command?: string;
  cwd?: string;
  createdAt?: string;
}

interface UseAgentSessionsResult {
  result: AgentSessionsListResult | null;
  groups: AgentSessionGroupingResult;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  searchQuery: string;
  selectedSessionId: string | null;
  selectedSession: AgentSession | null;
  selectedPtyId: string | null;
  selectedReentryResult: AgentSessionReentryResult | null;
  selectedMissing: boolean;
  reenteringSessionId: string | null;
  pinningSessionIds: Set<string>;
  collapsedGroupIds: Set<string>;
  setSearchQuery: (query: string) => void;
  refresh: () => Promise<void>;
  selectSession: (
    session: AgentSession,
    source: AgentSessionSelectionSource,
    groupId: string,
  ) => Promise<void>;
  togglePinned: (session: AgentSession) => Promise<void>;
  showMore: (groupId: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  setGroupsCollapsed: (groupIds: string[], collapsed: boolean) => void;
  openNewSessionTerminal: (scope: AgentSessionScopeGroup) => Promise<void>;
  closeSelectedTerminal: () => Promise<void>;
  closeTerminal: (sessionId: string, ptyId: string) => Promise<void>;
  closeAllTerminals: () => Promise<void>;
  openSelectedExternalTerminal: () => Promise<void>;
}

export function useAgentSessions(
  projectPath: string | null,
  spaceScopes: AgentSessionScopeGroup[] = [],
): UseAgentSessionsResult {
  const [result, setResult] = useState<AgentSessionsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleLimits, setVisibleLimits] = useState<Record<string, number>>(
    {},
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [selectedStableGroupId, setSelectedStableGroupId] = useState<
    string | null
  >(null);
  const [terminalsBySession, setTerminalsBySession] = useState<
    Record<string, SelectedTerminalState>
  >({});
  const [pendingTerminals, setPendingTerminals] = useState<
    PendingAgentSessionTerminal[]
  >([]);
  const [selectedReentryResult, setSelectedReentryResult] =
    useState<AgentSessionReentryResult | null>(null);
  const [reenteringSessionId, setReenteringSessionId] = useState<string | null>(
    null,
  );
  const [pinningSessionIds, setPinningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [windowActive, setWindowActive] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  );
  const requestIdRef = useRef(0);
  const selectionRequestIdRef = useRef(0);
  const projectPathRef = useRef(projectPath);
  const resultRef = useRef<AgentSessionsListResult | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const pendingTerminalsRef = useRef<PendingAgentSessionTerminal[]>([]);
  const loadInFlightRef = useRef<{
    projectPath: string;
    requestId: number;
    promise: Promise<void>;
  } | null>(null);
  const hotStatusInFlightRef = useRef<{
    projectPath: string;
    sessionIdsKey: string;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    pendingTerminalsRef.current = pendingTerminals;
  }, [pendingTerminals]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const updateWindowActive = () => {
      setWindowActive(document.visibilityState === "visible");
    };
    updateWindowActive();
    document.addEventListener("visibilitychange", updateWindowActive);
    window.addEventListener("focus", updateWindowActive);
    window.addEventListener("blur", updateWindowActive);
    return () => {
      document.removeEventListener("visibilitychange", updateWindowActive);
      window.removeEventListener("focus", updateWindowActive);
      window.removeEventListener("blur", updateWindowActive);
    };
  }, []);

  const reconcilePendingTerminals = useCallback((sessions: AgentSession[]) => {
    const pending = pendingTerminalsRef.current;
    if (pending.length === 0) return;

    const usedSessionIds = new Set<string>();
    const matches: Array<{
      pending: PendingAgentSessionTerminal;
      session: AgentSession;
    }> = [];
    const remaining: PendingAgentSessionTerminal[] = [];

    pending.forEach((item) => {
      const match = findMatchingSessionForPendingTerminal(
        item,
        sessions,
        usedSessionIds,
      );
      if (!match) {
        remaining.push(item);
        return;
      }
      usedSessionIds.add(match.id);
      matches.push({ pending: item, session: match });
    });

    if (matches.length === 0) return;

    const selectedBeforeReconcile = selectedSessionIdRef.current;
    pendingTerminalsRef.current = remaining;
    setPendingTerminals(remaining);
    setTerminalsBySession((current) => {
      const next = { ...current };
      matches.forEach(({ pending, session }) => {
        delete next[pending.id];
        next[session.id] = {
          ptyId: pending.ptyId,
          cwd: pending.cwd,
          createdAt: pending.createdAt,
        };
      });
      return next;
    });
    setSelectedSessionId((current) => {
      const match = matches.find(({ pending }) => pending.id === current);
      if (match) {
        selectedSessionIdRef.current = match.session.id;
      }
      return match?.session.id ?? current;
    });
    setSelectedStableGroupId((current) => {
      const selectedWasPending = matches.some(
        ({ pending }) => pending.id === selectedBeforeReconcile,
      );
      return selectedWasPending ? null : current;
    });
    setSelectedReentryResult((current) => {
      if (!current || !isPendingSessionId(current.sessionId)) return current;
      const match = matches.find(
        ({ pending }) => pending.id === current.sessionId,
      );
      return match ? null : current;
    });
  }, []);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!projectPath) {
        loadInFlightRef.current = null;
        setResult(null);
        setError(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const inFlight = loadInFlightRef.current;
      if (inFlight?.projectPath === projectPath) {
        return inFlight.promise;
      }

      const requestId = ++requestIdRef.current;
      const isCurrentRequest = () =>
        requestIdRef.current === requestId &&
        projectPathRef.current === projectPath;
      if (forceRefresh) {
        setRefreshing(true);
      } else {
        const hasResult = Boolean(resultRef.current);
        setLoading(!hasResult);
        setRefreshing(hasResult);
      }
      setError(null);

      const promise = (async () => {
        try {
          const next = forceRefresh
            ? await refreshAgentSessions(projectPath)
            : await listAgentSessions(projectPath);
          if (!isCurrentRequest()) return;
          reconcilePendingTerminals(next.sessions);
          setResult(next);
        } catch (err) {
          if (!isCurrentRequest()) return;
          setError(getNativeErrorMessage(err));
        } finally {
          if (isCurrentRequest()) {
            setLoading(false);
            setRefreshing(false);
          }
          if (loadInFlightRef.current?.requestId === requestId) {
            loadInFlightRef.current = null;
          }
        }
      })();
      loadInFlightRef.current = { projectPath, requestId, promise };
      return promise;
    },
    [projectPath, reconcilePendingTerminals],
  );

  const loadHotStatus = useCallback(
    async (sessionIds: string[]) => {
      if (!projectPath || sessionIds.length === 0 || !resultRef.current) {
        return;
      }
      if (loadInFlightRef.current) return loadInFlightRef.current.promise;
      if (hotStatusInFlightRef.current) {
        return hotStatusInFlightRef.current.promise;
      }

      const requestId = requestIdRef.current;
      const sessionIdsKey = sessionIds.join("\0");
      const promise = (async () => {
        try {
          const hotStatus = await hotStatusAgentSessions(
            projectPath,
            sessionIds,
          );
          if (
            requestIdRef.current !== requestId ||
            projectPathRef.current !== projectPath
          ) {
            return;
          }
          setResult((current) =>
            current
              ? mergeHotStatusSessions(current, hotStatus.sessions)
              : current,
          );
        } catch (error) {
          console.warn("Failed to refresh agent session hot status:", error);
        } finally {
          if (
            hotStatusInFlightRef.current?.projectPath === projectPath &&
            hotStatusInFlightRef.current.sessionIdsKey === sessionIdsKey
          ) {
            hotStatusInFlightRef.current = null;
          }
        }
      })();
      hotStatusInFlightRef.current = { projectPath, sessionIdsKey, promise };
      return promise;
    },
    [projectPath],
  );

  useEffect(() => {
    selectionRequestIdRef.current += 1;
    hotStatusInFlightRef.current = null;
    resultRef.current = null;
    setResult(null);
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    setSelectedStableGroupId(null);
    setSelectedReentryResult(null);
    setReenteringSessionId(null);
    setPinningSessionIds(new Set());
    setTerminalsBySession({});
    setPendingTerminals([]);
    pendingTerminalsRef.current = [];
    setVisibleLimits({});
    setCollapsedGroupIds(new Set());
    void load(false);
  }, [load, projectPath]);

  useEffect(() => {
    if (!projectPath) return;
    const interval = window.setInterval(() => {
      void load(false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load, projectPath]);

  useEffect(() => {
    if (!projectPath || pendingTerminals.length === 0) return;
    const interval = window.setInterval(() => {
      void load(true);
    }, PENDING_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load, pendingTerminals.length, projectPath]);

  const sessionsForUi = useMemo(() => {
    const backendSessions = (result?.sessions ?? []).map((session) =>
      applyLocalTerminalRuntime(session, terminalsBySession[session.id]),
    );
    const pendingSessions = pendingTerminals.map(buildPendingAgentSession);
    return [...backendSessions, ...pendingSessions];
  }, [pendingTerminals, result?.sessions, terminalsBySession]);

  const hotStatusSessionIdsKey = useMemo(
    () =>
      buildHotStatusSessionIds({
        sessions: sessionsForUi,
        selectedSessionId,
      }).join("\0"),
    [selectedSessionId, sessionsForUi],
  );

  const groups = useMemo(
    () =>
      buildAgentSessionGroups({
        sessions: sessionsForUi,
        spaceScopes,
        searchQuery,
        visibleLimits,
        selectedSessionId,
        selectedStableGroupId,
      }),
    [
      searchQuery,
      selectedSessionId,
      selectedStableGroupId,
      sessionsForUi,
      spaceScopes,
      visibleLimits,
    ],
  );

  useEffect(() => {
    if (!projectPath || !hotStatusSessionIdsKey) return;

    const sessionIds = hotStatusSessionIdsKey.split("\0").filter(Boolean);
    const pollInterval = windowActive
      ? HOT_STATUS_POLL_INTERVAL_MS
      : HIDDEN_HOT_STATUS_POLL_INTERVAL_MS;
    void loadHotStatus(sessionIds);
    const interval = window.setInterval(() => {
      void loadHotStatus(sessionIds);
    }, pollInterval);
    return () => window.clearInterval(interval);
  }, [hotStatusSessionIdsKey, loadHotStatus, projectPath, windowActive]);

  const selectedSession =
    sessionsForUi.find((session) => session.id === selectedSessionId) ?? null;
  const selectedTerminal = selectedSessionId
    ? terminalsBySession[selectedSessionId]
    : undefined;
  const selectedPtyId =
    selectedSession?.runtime?.ptyId ??
    selectedTerminal?.ptyId ??
    selectedReentryResult?.ptyId ??
    null;
  const selectedMissing =
    Boolean(selectedSessionId) && !selectedSession && !selectedPtyId;

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  const selectSession = useCallback(
    async (
      session: AgentSession,
      source: AgentSessionSelectionSource,
      groupId: string,
    ) => {
      if (!projectPath) return;

      const selectionRequestId = ++selectionRequestIdRef.current;
      selectedSessionIdRef.current = session.id;
      setSelectedSessionId(session.id);
      setSelectedStableGroupId(source === "space" ? groupId : null);
      setSelectedReentryResult(null);

      if (isPendingSessionId(session.id)) {
        setReenteringSessionId(null);
        return;
      }

      setReenteringSessionId(session.id);

      try {
        const reentry = await reenterAgentSession(projectPath, session.id);
        const ptyId = reentry.ptyId;
        const projectUnchanged = projectPathRef.current === projectPath;
        const selectionCurrent =
          projectUnchanged &&
          selectionRequestIdRef.current === selectionRequestId;

        if (ptyId && projectUnchanged) {
          const openedAt = new Date().toISOString();
          setTerminalsBySession((current) => ({
            ...current,
            [session.id]: {
              ptyId,
              command:
                reentry.command?.display ?? session.resumeCommand?.display,
              cwd: reentry.cwd ?? reentry.command?.cwd ?? session.cwd,
              createdAt: openedAt,
            },
          }));
        }
        if (!selectionCurrent) return;
        setSelectedReentryResult(reentry);
        void load(false);
      } catch (err) {
        if (
          projectPathRef.current !== projectPath ||
          selectionRequestIdRef.current !== selectionRequestId
        ) {
          return;
        }
        setSelectedReentryResult({
          mode: "error",
          sessionId: session.id,
          command: session.resumeCommand,
          cwd: session.cwd,
          error: {
            code: "unknown",
            message: getNativeErrorMessage(err),
          },
        });
      } finally {
        if (
          projectPathRef.current === projectPath &&
          selectionRequestIdRef.current === selectionRequestId
        ) {
          setReenteringSessionId(null);
        }
      }
    },
    [load, projectPath],
  );

  const togglePinned = useCallback(
    async (session: AgentSession) => {
      if (
        !projectPath ||
        pinningSessionIds.has(session.id) ||
        isPendingSessionId(session.id) ||
        session.source === "unknown"
      ) {
        return;
      }

      const pinnedProjectPath = projectPath;
      setPinningSessionIds((current) => new Set(current).add(session.id));
      try {
        await setAgentSessionPinned(
          pinnedProjectPath,
          session.id,
          !session.pinned,
        );
        if (projectPathRef.current !== pinnedProjectPath) return;
        setResult((current) =>
          current
            ? {
                ...current,
                sessions: current.sessions.map((item) =>
                  item.id === session.id
                    ? { ...item, pinned: !session.pinned }
                    : item,
                ),
              }
            : current,
        );
        await load(false);
      } finally {
        if (projectPathRef.current === pinnedProjectPath) {
          setPinningSessionIds((current) => {
            const next = new Set(current);
            next.delete(session.id);
            return next;
          });
        }
      }
    },
    [load, pinningSessionIds, projectPath],
  );

  const showMore = useCallback((groupId: string) => {
    setVisibleLimits((current) => ({
      ...current,
      [groupId]: (current[groupId] ?? DEFAULT_SPACE_GROUP_LIMIT) + 10,
    }));
  }, []);

  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const setGroupsCollapsed = useCallback(
    (groupIds: string[], collapsed: boolean) => {
      if (groupIds.length === 0) return;

      setCollapsedGroupIds((current) => {
        const next = new Set(current);
        groupIds.forEach((groupId) => {
          if (collapsed) {
            next.add(groupId);
          } else {
            next.delete(groupId);
          }
        });
        return next;
      });
    },
    [],
  );

  const openNewSessionTerminal = useCallback(
    async (scope: AgentSessionScopeGroup) => {
      if (!projectPath || scope.status !== "ready") return;

      const openedAt = new Date().toISOString();
      const terminal = await spawnManagedTerminalSurface(
        scope.path,
        projectPath,
      );
      if (projectPathRef.current !== projectPath) {
        await closeManagedTerminalSurface(terminal.ptyId);
        return;
      }

      const pending: PendingAgentSessionTerminal = {
        id: pendingSessionId(terminal.ptyId),
        ptyId: terminal.ptyId,
        title: m.sessions_new_title(),
        scope,
        cwd: terminal.cwd || scope.path,
        createdAt: openedAt,
      };
      pendingTerminalsRef.current = [...pendingTerminalsRef.current, pending];
      setPendingTerminals((current) => [...current, pending]);
      setTerminalsBySession((current) => ({
        ...current,
        [pending.id]: {
          ptyId: pending.ptyId,
          cwd: pending.cwd,
          createdAt: pending.createdAt,
        },
      }));
      setSelectedSessionId(pending.id);
      selectedSessionIdRef.current = pending.id;
      setSelectedStableGroupId(null);
      setSelectedReentryResult(null);
      setReenteringSessionId(null);
      void load(true);
    },
    [load, projectPath],
  );

  const closeTerminal = useCallback(
    async (sessionId: string, ptyId: string) => {
      await closeManagedTerminalSurface(ptyId);
      setPendingTerminals((current) => {
        const next = current.filter(
          (pending) => pending.id !== sessionId && pending.ptyId !== ptyId,
        );
        pendingTerminalsRef.current = next;
        return next;
      });
      setTerminalsBySession((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setSelectedReentryResult((current) =>
        current?.ptyId === ptyId ? null : current,
      );
      await load(false);
    },
    [load],
  );

  const closeSelectedTerminal = useCallback(async () => {
    if (!selectedSessionId || !selectedPtyId) return;
    await closeTerminal(selectedSessionId, selectedPtyId);
  }, [closeTerminal, selectedPtyId, selectedSessionId]);

  const closeAllTerminals = useCallback(async () => {
    const ptyIds = new Set<string>();

    sessionsForUi.forEach((session) => {
      if (session.runtime?.ptyId) {
        ptyIds.add(session.runtime.ptyId);
      }
    });
    Object.values(terminalsBySession).forEach((terminal) => {
      ptyIds.add(terminal.ptyId);
    });
    if (selectedReentryResult?.ptyId) {
      ptyIds.add(selectedReentryResult.ptyId);
    }

    if (ptyIds.size === 0) return;

    const results = await Promise.allSettled(
      Array.from(ptyIds, async (ptyId) => {
        await closeManagedTerminalSurface(ptyId);
        return ptyId;
      }),
    );
    const closedPtyIds = new Set(
      results
        .filter(
          (result): result is PromiseFulfilledResult<string> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value),
    );

    if (closedPtyIds.size > 0) {
      setPendingTerminals((current) => {
        const next = current.filter(
          (pending) => !closedPtyIds.has(pending.ptyId),
        );
        pendingTerminalsRef.current = next;
        return next;
      });
      setTerminalsBySession((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([, terminal]) => !closedPtyIds.has(terminal.ptyId),
          ),
        ),
      );
      setSelectedReentryResult((current) =>
        current?.ptyId && closedPtyIds.has(current.ptyId) ? null : current,
      );
      await load(false);
    }

    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }, [load, selectedReentryResult, sessionsForUi, terminalsBySession]);

  const openSelectedExternalTerminal = useCallback(async () => {
    const cwd =
      selectedReentryResult?.cwd ??
      selectedReentryResult?.command?.cwd ??
      selectedSession?.resumeCommand?.cwd ??
      selectedSession?.cwd;
    if (!cwd) return;
    await openSessionCwdInExternalTerminal(cwd);
  }, [selectedReentryResult, selectedSession]);

  return {
    result,
    groups,
    loading,
    refreshing,
    error,
    searchQuery,
    selectedSessionId,
    selectedSession,
    selectedPtyId,
    selectedReentryResult,
    selectedMissing,
    reenteringSessionId,
    pinningSessionIds,
    collapsedGroupIds,
    setSearchQuery,
    refresh,
    selectSession,
    togglePinned,
    showMore,
    toggleGroupCollapsed,
    setGroupsCollapsed,
    openNewSessionTerminal,
    closeSelectedTerminal,
    closeTerminal,
    closeAllTerminals,
    openSelectedExternalTerminal,
  };
}

function mergeHotStatusSessions(
  current: AgentSessionsListResult,
  hotSessions: AgentSessionsListResult["sessions"],
): AgentSessionsListResult {
  if (hotSessions.length === 0) return current;

  const hotById = new Map(hotSessions.map((session) => [session.id, session]));
  let changed = false;
  const sessions = current.sessions.map((session) => {
    const hot = hotById.get(session.id);
    if (!hot) return session;
    changed = true;
    return hot;
  });

  return changed ? { ...current, sessions } : current;
}
