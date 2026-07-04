import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listAgentSessions,
  openSessionCwdInExternalTerminal,
  reenterAgentSession,
  refreshAgentSessions,
  revealSessionFile,
  setAgentSessionPinned,
  type AgentSession,
  type AgentSessionReentryResult,
  type AgentSessionsListResult,
} from "../api";
import {
  DEFAULT_SPACE_GROUP_LIMIT,
  buildAgentSessionGroups,
  type AgentSessionGroupingResult,
  type AgentSessionSelectionSource,
} from "../model";
import { closeManagedTerminalSurface } from "@/features/terminal/session-surface";
import { getNativeErrorMessage } from "@/platform/native/errors";

const POLL_INTERVAL_MS = 45_000;

interface SelectedTerminalState {
  ptyId: string;
  command?: string;
  cwd?: string;
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
  closeSelectedTerminal: () => Promise<void>;
  closeTerminal: (sessionId: string, ptyId: string) => Promise<void>;
  openSelectedExternalTerminal: () => Promise<void>;
  revealSelectedSourceFile: () => Promise<void>;
}

export function useAgentSessions(
  projectPath: string | null,
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
  const [selectedReentryResult, setSelectedReentryResult] =
    useState<AgentSessionReentryResult | null>(null);
  const [reenteringSessionId, setReenteringSessionId] = useState<string | null>(
    null,
  );
  const [pinningSessionIds, setPinningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const requestIdRef = useRef(0);
  const selectionRequestIdRef = useRef(0);
  const projectPathRef = useRef(projectPath);
  const resultRef = useRef<AgentSessionsListResult | null>(null);
  const loadInFlightRef = useRef<{
    projectPath: string;
    requestId: number;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

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
    [projectPath],
  );

  useEffect(() => {
    selectionRequestIdRef.current += 1;
    resultRef.current = null;
    setResult(null);
    setSelectedSessionId(null);
    setSelectedStableGroupId(null);
    setSelectedReentryResult(null);
    setReenteringSessionId(null);
    setPinningSessionIds(new Set());
    setTerminalsBySession({});
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

  const groups = useMemo(
    () =>
      buildAgentSessionGroups({
        sessions: result?.sessions ?? [],
        searchQuery,
        visibleLimits,
        selectedSessionId,
        selectedStableGroupId,
      }),
    [
      result?.sessions,
      searchQuery,
      selectedSessionId,
      selectedStableGroupId,
      visibleLimits,
    ],
  );

  const selectedSession =
    result?.sessions.find((session) => session.id === selectedSessionId) ??
    null;
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
      setSelectedSessionId(session.id);
      setSelectedStableGroupId(source === "space" ? groupId : null);
      setSelectedReentryResult(null);
      setReenteringSessionId(session.id);

      try {
        const reentry = await reenterAgentSession(projectPath, session.id);
        const ptyId = reentry.ptyId;
        const projectUnchanged = projectPathRef.current === projectPath;
        const selectionCurrent =
          projectUnchanged &&
          selectionRequestIdRef.current === selectionRequestId;

        if (ptyId && projectUnchanged) {
          setTerminalsBySession((current) => ({
            ...current,
            [session.id]: {
              ptyId,
              command:
                reentry.command?.display ?? session.resumeCommand?.display,
              cwd: reentry.cwd ?? reentry.command?.cwd ?? session.cwd,
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
      if (!projectPath || pinningSessionIds.has(session.id)) return;

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

  const closeTerminal = useCallback(
    async (sessionId: string, ptyId: string) => {
      await closeManagedTerminalSurface(ptyId);
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

  const openSelectedExternalTerminal = useCallback(async () => {
    const cwd =
      selectedReentryResult?.cwd ??
      selectedReentryResult?.command?.cwd ??
      selectedSession?.resumeCommand?.cwd ??
      selectedSession?.cwd;
    if (!cwd) return;
    await openSessionCwdInExternalTerminal(cwd);
  }, [selectedReentryResult, selectedSession]);

  const revealSelectedSourceFile = useCallback(async () => {
    const sourceFile = selectedSession?.sourceFile;
    if (!sourceFile) return;
    await revealSessionFile(sourceFile.path);
  }, [selectedSession]);

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
    closeSelectedTerminal,
    closeTerminal,
    openSelectedExternalTerminal,
    revealSelectedSourceFile,
  };
}
