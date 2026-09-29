import { useCallback, useEffect, useMemo, useState } from "react";
import {
  openSessionCwdInExternalTerminal,
  type AgentSessionReentryResult,
  type AgentSessionsListResult,
} from "../api";
import {
  DEFAULT_SPACE_GROUP_LIMIT,
  buildAgentSessionGroups,
  isPendingSessionId,
  resolveAgentSessionId,
  type AgentSession,
  type AgentSessionGroupingResult,
  type AgentSessionSelectionSource,
  type AgentSessionScopeGroup,
} from "../model";
import { useAgentSessionCatalog } from "./use-agent-session-catalog";
import * as m from "@/paraglide/messages.js";

interface SessionSelection {
  sessionId: string;
  launchId: string | null;
  /** Space group that keeps a selected session in place while it changes. */
  groupId: string | null;
}

function selectionFor(
  session: AgentSession,
  groupId: string | null,
): SessionSelection {
  return { sessionId: session.id, launchId: session.launchId ?? null, groupId };
}

/**
 * The selected session follows its identity handoffs: a pending terminal to
 * the CLI session matched to it, and a provisional launch to its canonical
 * session with the same launch id.
 */
function resolveSelection(
  selection: SessionSelection | null,
  sessions: AgentSession[],
  pendingHandoffs: Record<string, string>,
): { selectedSessionId: string | null; selectedStableGroupId: string | null } {
  if (!selection)
    return { selectedSessionId: null, selectedStableGroupId: null };

  const sessionId = resolveAgentSessionId(selection, sessions, pendingHandoffs);

  return {
    selectedSessionId: sessionId,
    selectedStableGroupId:
      sessionId === selection.sessionId ? selection.groupId : null,
  };
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
  pinningSessionIds: ReadonlySet<string>;
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

/**
 * Sessions screen view over the project session catalog: selection, search and
 * grouping stay local to the screen, while the catalog, re-entry state and
 * session terminals belong to the catalog owner and outlive this screen.
 */
export function useAgentSessions(
  projectPath: string | null,
  spaceScopes: AgentSessionScopeGroup[] = [],
): UseAgentSessionsResult {
  const result = useAgentSessionCatalog((state) => state.result);
  const sessions = useAgentSessionCatalog((state) => state.sessions);
  const loading = useAgentSessionCatalog((state) => state.loading);
  const refreshing = useAgentSessionCatalog((state) => state.refreshing);
  const error = useAgentSessionCatalog((state) => state.error);
  const terminals = useAgentSessionCatalog((state) => state.terminals);
  const reentryResults = useAgentSessionCatalog(
    (state) => state.reentryResults,
  );
  const reenteringSessionIds = useAgentSessionCatalog(
    (state) => state.reenteringSessionIds,
  );
  const pinningSessionIds = useAgentSessionCatalog(
    (state) => state.pinningSessionIds,
  );
  const pendingHandoffs = useAgentSessionCatalog(
    (state) => state.pendingHandoffs,
  );
  const load = useAgentSessionCatalog((state) => state.load);
  const reenter = useAgentSessionCatalog((state) => state.reenter);
  const observeSession = useAgentSessionCatalog(
    (state) => state.observeSession,
  );
  const togglePinned = useAgentSessionCatalog((state) => state.togglePinned);
  const openCatalogTerminal = useAgentSessionCatalog(
    (state) => state.openNewSessionTerminal,
  );
  const closeTerminal = useAgentSessionCatalog((state) => state.closeTerminal);
  const closeAllTerminals = useAgentSessionCatalog(
    (state) => state.closeAllTerminals,
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [visibleLimits, setVisibleLimits] = useState<Record<string, number>>(
    {},
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selection, setSelection] = useState<SessionSelection | null>(null);

  const { selectedSessionId, selectedStableGroupId } = resolveSelection(
    selection,
    sessions,
    pendingHandoffs,
  );

  // Opening the screen asks the catalog for the full list.
  useEffect(() => {
    if (projectPath) void load();
  }, [load, projectPath]);

  useEffect(() => {
    if (!selectedSessionId) return;
    return observeSession(selectedSessionId);
  }, [observeSession, selectedSessionId]);

  const groups = useMemo(
    () =>
      buildAgentSessionGroups({
        sessions,
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
      sessions,
      spaceScopes,
      visibleLimits,
    ],
  );

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedReentryResult = selectedSessionId
    ? (reentryResults[selectedSessionId] ?? null)
    : null;
  const selectedPtyId =
    selectedSession?.runtime?.ptyId ??
    (selectedSessionId ? terminals[selectedSessionId]?.ptyId : undefined) ??
    selectedReentryResult?.ptyId ??
    null;
  const selectedMissing =
    Boolean(selectedSessionId) && !selectedSession && !selectedPtyId;
  const reenteringSessionId =
    selectedSessionId && reenteringSessionIds.has(selectedSessionId)
      ? selectedSessionId
      : null;

  const refresh = useCallback(() => load({ force: true }), [load]);

  const selectSession = useCallback(
    async (
      session: AgentSession,
      source: AgentSessionSelectionSource,
      groupId: string,
    ) => {
      if (!projectPath) return;
      setSelection(selectionFor(session, source === "space" ? groupId : null));
      if (isPendingSessionId(session.id)) return;
      await reenter(session);
    },
    [projectPath, reenter],
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
      const pendingId = await openCatalogTerminal(
        scope,
        m.sessions_new_title(),
      );
      if (pendingId) {
        setSelection({ sessionId: pendingId, launchId: null, groupId: null });
      }
    },
    [openCatalogTerminal],
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
