import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AgentSessionReentryResult,
  AgentSessionsHotStatusResult,
  AgentSessionsListResult,
} from "../api";
import {
  buildPendingAgentSession,
  findMatchingSessionForPendingTerminal,
  findSessionBoundToPendingTerminal,
  isPendingSessionId,
  pendingSessionId,
  type PendingAgentSessionTerminal,
} from "./pending";
import { resolveAgentSessionId, type AgentSessionTarget } from "./target";
import { liveTerminalPtyId } from "./terminal-follow";
import type { AgentSession, AgentSessionScopeGroup } from "./types";

/** A managed terminal linked to the session its agent CLI runs. */
export interface AgentSessionTerminalRegistration {
  ptyId: string;
  agentSessionId: string;
  title: string;
  source: string;
  sourceSessionId: string;
  shellCwd: string;
  createdAt: string;
}

/** Backend and terminal effects the project session catalog depends on. */
export interface AgentSessionCatalogApi {
  list: (projectPath: string) => Promise<AgentSessionsListResult>;
  refresh: (projectPath: string) => Promise<AgentSessionsListResult>;
  /** Starts the catalogue connections an open collection needs. */
  raiseCatalog: () => Promise<void>;
  hotStatus: (
    projectPath: string,
    sessionIds: string[],
  ) => Promise<AgentSessionsHotStatusResult>;
  reenter: (
    projectPath: string,
    sessionId: string,
  ) => Promise<AgentSessionReentryResult>;
  spawnTerminal: (
    cwd: string,
    projectPath: string,
  ) => Promise<{ ptyId: string; cwd: string }>;
  closeTerminal: (ptyId: string) => Promise<void>;
  /**
   * Makes the terminal the backend surface and writer of the session, so
   * the read-model reports it as the session runtime.
   */
  registerTerminal: (
    registration: AgentSessionTerminalRegistration,
  ) => Promise<void>;
  errorMessage: (error: unknown) => string;
}

export interface AgentSessionCatalogLoadOptions {
  force?: boolean;
}

export interface AgentSessionCatalogState {
  projectPath: string | null;
  result: AgentSessionsListResult | null;
  /** Listed sessions, followed by pending sessions. */
  sessions: AgentSession[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Completion time of the last successful full list, in epoch ms. */
  listedAt: number | null;
  /** New-session terminals the read-model does not list as a session runtime yet. */
  pendingTerminals: PendingAgentSessionTerminal[];
  /** Pending session id → canonical session id its terminal became the runtime of. */
  pendingHandoffs: Record<string, string>;
  /**
   * Live terminals the latest read lists at no session, as while the agent
   * in one has gone on to a session the catalog has not read yet (DF-163
   * R3); each stays with the last session the read-model listed it at.
   */
  unlistedTerminalPtyIds: ReadonlySet<string>;
  reentryResults: Record<string, AgentSessionReentryResult>;
  reenteringSessionIds: ReadonlySet<string>;
  /** Session ids a consumer keeps under hot status while it shows them. */
  observedSessionIds: Record<string, number>;
  /** Consumers that need the accelerated full-list refresh while visible. */
  fastRefreshDemand: number;

  setProject: (projectPath: string | null) => void;
  load: (options?: AgentSessionCatalogLoadOptions) => Promise<void>;
  /**
   * An explicit refresh or a return to the foreground: starts the agent
   * connections an open Sessions collection needs. Polls never call it.
   */
  raiseCatalog: () => void;
  /** Loads until a list that started after the call has been read for the target. */
  loadTarget: (target: AgentSessionTarget) => Promise<void>;
  loadHotStatus: (sessionIds: string[]) => Promise<void>;
  reenter: (session: AgentSession) => Promise<void>;
  openNewSessionTerminal: (
    scope: AgentSessionScopeGroup,
    title: string,
  ) => Promise<string | null>;
  closeTerminal: (sessionId: string, ptyId: string) => Promise<void>;
  /** Forgets a session terminal whose process has exited. */
  releaseTerminal: (ptyId: string) => void;
  observeSession: (sessionId: string) => () => void;
  requestFastRefresh: () => () => void;
}

export type AgentSessionCatalogStore = StoreApi<AgentSessionCatalogState>;

type CatalogData = Omit<
  AgentSessionCatalogState,
  | "setProject"
  | "load"
  | "raiseCatalog"
  | "loadTarget"
  | "loadHotStatus"
  | "reenter"
  | "openNewSessionTerminal"
  | "closeTerminal"
  | "releaseTerminal"
  | "observeSession"
  | "requestFastRefresh"
>;

const EMPTY_SET: ReadonlySet<string> = new Set();

function emptyCatalogData(projectPath: string | null): CatalogData {
  return {
    projectPath,
    result: null,
    sessions: [],
    loading: false,
    refreshing: false,
    error: null,
    listedAt: null,
    pendingTerminals: [],
    pendingHandoffs: {},
    unlistedTerminalPtyIds: EMPTY_SET,
    reentryResults: {},
    reenteringSessionIds: EMPTY_SET,
    observedSessionIds: {},
    fastRefreshDemand: 0,
  };
}

function deriveSessions(
  result: AgentSessionsListResult | null,
  pendingTerminals: PendingAgentSessionTerminal[],
): AgentSession[] {
  return [
    ...(result?.sessions ?? []),
    ...pendingTerminals.map(buildPendingAgentSession),
  ];
}

function withSessions(
  state: AgentSessionCatalogState,
  patch: Partial<CatalogData>,
): Partial<CatalogData> {
  if (!("result" in patch) && !("pendingTerminals" in patch)) {
    return patch;
  }
  return {
    ...patch,
    sessions: deriveSessions(
      patch.result !== undefined ? patch.result : state.result,
      patch.pendingTerminals ?? state.pendingTerminals,
    ),
  };
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function withSetItem(set: ReadonlySet<string>, item: string, present: boolean) {
  if (set.has(item) === present) return set;
  const next = new Set(set);
  if (present) {
    next.add(item);
  } else {
    next.delete(item);
  }
  return next;
}

function withoutTerminalRuntime(
  result: AgentSessionsListResult | null,
  ptyIds: ReadonlySet<string>,
): AgentSessionsListResult | null {
  if (!result) return result;
  let changed = false;
  const sessions = result.sessions.map((session) => {
    const ptyId = session.runtime?.ptyId;
    if (!ptyId || !ptyIds.has(ptyId)) return session;
    changed = true;
    return {
      ...session,
      runtime: { ...session.runtime, ptyId: undefined, live: false },
    };
  });
  return changed ? { ...result, sessions } : result;
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

/**
 * A new read with each live terminal of the previous one that it lists at
 * no session put back at the session it was listed at, and those terminals.
 * The agent in such a terminal went on to a session the read does not
 * name (DF-163 R3): a hot status reads only the sessions asked for, and a
 * new Claude Code session is listed only after its first prompt. The last
 * binding of the read-model stays until a read names the new session; an
 * exited or closed terminal has already left the previous read.
 */
function keepUnlistedTerminals(
  previous: AgentSessionsListResult | null,
  next: AgentSessionsListResult,
): { result: AgentSessionsListResult; unlisted: ReadonlySet<string> } {
  const listedPtyIds = new Set(next.sessions.map(liveTerminalPtyId));
  const kept = new Map<string, AgentSession>();
  for (const session of previous?.sessions ?? []) {
    const ptyId = liveTerminalPtyId(session);
    if (ptyId && !listedPtyIds.has(ptyId)) kept.set(session.id, session);
  }
  if (kept.size === 0) return { result: next, unlisted: EMPTY_SET };

  const unlisted = new Set<string>();
  const sessions = next.sessions.map((session) => {
    const last = kept.get(session.id);
    if (!last?.runtime?.ptyId) return session;
    unlisted.add(last.runtime.ptyId);
    return { ...session, runtime: last.runtime };
  });
  return {
    result: unlisted.size > 0 ? { ...next, sessions } : next,
    unlisted: unlisted.size > 0 ? unlisted : EMPTY_SET,
  };
}

/**
 * Re-entry results without those whose terminal the read-model lists at
 * another session: the agent CLI in it went on to that session (DF-163 R3),
 * so the session it was resumed for no longer has it.
 */
function withoutMovedReentryTerminals(
  reentryResults: Record<string, AgentSessionReentryResult>,
  sessions: AgentSessionsListResult["sessions"],
): Record<string, AgentSessionReentryResult> {
  const ownerByPtyId = new Map<string, string>();
  for (const session of sessions) {
    const ptyId = liveTerminalPtyId(session);
    if (ptyId) ownerByPtyId.set(ptyId, session.id);
  }
  let moved = false;
  const kept = Object.fromEntries(
    Object.entries(reentryResults).filter(([sessionId, result]) => {
      const owner = result.ptyId ? ownerByPtyId.get(result.ptyId) : undefined;
      const stays = owner === undefined || owner === sessionId;
      if (!stays) moved = true;
      return stays;
    }),
  );
  return moved ? kept : reentryResults;
}

/**
 * The single frontend owner of the active project's Agent Sessions catalog:
 * the listed read-model, hot status, pending and provisional records, re-entry
 * results and managed terminals opened for sessions. Consumers read it; only
 * the refresh lifecycle decides when the full list is polled.
 */
export function createAgentSessionCatalogStore(
  api: AgentSessionCatalogApi,
  now: () => number = Date.now,
): AgentSessionCatalogStore {
  let generation = 0;
  let requestId = 0;
  let listInFlight: {
    generation: number;
    requestId: number;
    promise: Promise<void>;
  } | null = null;
  let hotRequestId = 0;
  let hotInFlight: {
    generation: number;
    requestId: number;
    promise: Promise<void>;
  } | null = null;
  let reentryRequestId = 0;
  const reentryInFlight = new Map<
    string,
    { generation: number; requestId: number; promise: Promise<void> }
  >();

  return createStore<AgentSessionCatalogState>()((set, get) => {
    const update = (patch: Partial<CatalogData>) =>
      set((state) => withSessions(state, patch));
    const isCurrentProject = (token: number, projectPath: string) =>
      generation === token && get().projectPath === projectPath;

    /**
     * Registers each pending terminal recognized as a listed session as that
     * session's backend surface; true when one was registered, so the next
     * list reports it as the session runtime.
     */
    const registerRecognizedTerminals = async (sessions: AgentSession[]) => {
      const usedSessionIds = new Set<string>();
      let registered = false;
      for (const pending of get().pendingTerminals) {
        if (findSessionBoundToPendingTerminal(pending, sessions)) continue;
        const match = findMatchingSessionForPendingTerminal(
          pending,
          sessions,
          usedSessionIds,
        );
        if (!match) continue;
        usedSessionIds.add(match.id);
        try {
          await api.registerTerminal({
            ptyId: pending.ptyId,
            agentSessionId: match.id,
            title: match.title,
            source: match.source,
            sourceSessionId: match.sourceSessionId,
            shellCwd: pending.cwd,
            createdAt: pending.createdAt,
          });
          registered = true;
        } catch (error) {
          // The terminal stays pending and is recognized again on the next list.
          console.warn("Failed to link a new session terminal:", error);
        }
      }
      return registered;
    };

    /** Hands each pending terminal off to the session listed with it as runtime. */
    const handOffPendingTerminals = (
      sessions: AgentSession[],
    ): Partial<CatalogData> => {
      const { pendingTerminals, reentryResults, pendingHandoffs } = get();
      if (pendingTerminals.length === 0) return {};

      const remaining: PendingAgentSessionTerminal[] = [];
      let nextReentryResults = reentryResults;
      const nextHandoffs = { ...pendingHandoffs };
      let handedOff = false;

      pendingTerminals.forEach((pending) => {
        const session = findSessionBoundToPendingTerminal(pending, sessions);
        if (!session) {
          remaining.push(pending);
          return;
        }
        handedOff = true;
        nextReentryResults = withoutKey(nextReentryResults, pending.id);
        nextHandoffs[pending.id] = session.id;
      });

      if (!handedOff) return {};
      return {
        pendingTerminals: remaining,
        reentryResults: nextReentryResults,
        pendingHandoffs: nextHandoffs,
      };
    };

    const load = async ({
      force = false,
    }: AgentSessionCatalogLoadOptions = {}) => {
      const projectPath = get().projectPath;
      if (!projectPath) return;
      if (listInFlight?.generation === generation) return listInFlight.promise;

      const token = generation;
      const currentRequestId = ++requestId;
      const hasResult = Boolean(get().result);
      update({
        loading: !force && !hasResult,
        refreshing: force || hasResult,
        error: null,
      });

      const promise = (async () => {
        try {
          let next = force
            ? await api.refresh(projectPath)
            : await api.list(projectPath);
          if (!isCurrentProject(token, projectPath)) return;
          if (await registerRecognizedTerminals(next.sessions)) {
            if (!isCurrentProject(token, projectPath)) return;
            next = await api.list(projectPath);
            if (!isCurrentProject(token, projectPath)) return;
          }
          const { result, unlisted } = keepUnlistedTerminals(
            get().result,
            next,
          );
          const handoff = handOffPendingTerminals(result.sessions);
          update({
            ...handoff,
            reentryResults: withoutMovedReentryTerminals(
              handoff.reentryResults ?? get().reentryResults,
              result.sessions,
            ),
            result,
            unlistedTerminalPtyIds: unlisted,
            listedAt: now(),
          });
        } catch (error) {
          if (!isCurrentProject(token, projectPath)) return;
          update({ error: api.errorMessage(error) });
        } finally {
          if (isCurrentProject(token, projectPath)) {
            update({ loading: false, refreshing: false });
          }
          if (listInFlight?.requestId === currentRequestId) {
            listInFlight = null;
          }
        }
      })();
      listInFlight = {
        generation: token,
        requestId: currentRequestId,
        promise,
      };
      return promise;
    };

    /** Drops runtime of terminals that no longer run. */
    const forgetTerminals = (ptyIds: ReadonlySet<string>) => {
      const current = get();
      update({
        result: withoutTerminalRuntime(current.result, ptyIds),
        pendingTerminals: current.pendingTerminals.filter(
          (pending) => !ptyIds.has(pending.ptyId),
        ),
        reentryResults: Object.fromEntries(
          Object.entries(current.reentryResults).filter(
            ([, result]) => !result.ptyId || !ptyIds.has(result.ptyId),
          ),
        ),
        unlistedTerminalPtyIds: new Set(
          [...current.unlistedTerminalPtyIds].filter(
            (ptyId) => !ptyIds.has(ptyId),
          ),
        ),
      });
    };

    return {
      ...emptyCatalogData(null),

      setProject: (projectPath) => {
        if (get().projectPath === projectPath) return;
        generation += 1;
        listInFlight = null;
        hotInFlight = null;
        reentryInFlight.clear();
        const { observedSessionIds, fastRefreshDemand } = get();
        set({
          ...emptyCatalogData(projectPath),
          observedSessionIds,
          fastRefreshDemand,
        });
      },

      load,

      raiseCatalog: () => {
        if (!get().projectPath) return;
        api.raiseCatalog().catch((error: unknown) => {
          console.error("Failed to start agent catalogue connections:", error);
        });
      },

      loadTarget: async (target) => {
        await load();
        const { sessions, pendingHandoffs } = get();
        const sessionId = resolveAgentSessionId(
          target,
          sessions,
          pendingHandoffs,
        );
        if (sessions.some((session) => session.id === sessionId)) return;
        await load();
      },

      loadHotStatus: async (sessionIds) => {
        const projectPath = get().projectPath;
        if (!projectPath || sessionIds.length === 0 || !get().result) return;
        if (listInFlight?.generation === generation)
          return listInFlight.promise;
        if (hotInFlight?.generation === generation) return hotInFlight.promise;

        const token = generation;
        const listRequestId = requestId;
        const currentHotRequestId = ++hotRequestId;
        const promise = (async () => {
          try {
            const hot = await api.hotStatus(projectPath, sessionIds);
            if (
              !isCurrentProject(token, projectPath) ||
              requestId !== listRequestId
            ) {
              return;
            }
            const current = get().result;
            if (!current) return;
            const { result, unlisted } = keepUnlistedTerminals(
              current,
              mergeHotStatusSessions(current, hot.sessions),
            );
            const known = get().unlistedTerminalPtyIds;
            update({
              result,
              reentryResults: withoutMovedReentryTerminals(
                get().reentryResults,
                result.sessions,
              ),
              unlistedTerminalPtyIds: unlisted,
            });
            // A terminal this read is the first to leave unlisted: the full
            // list may already name the session its agent went on to.
            if ([...unlisted].some((ptyId) => !known.has(ptyId))) void load();
          } catch (error) {
            console.warn("Failed to refresh agent session hot status:", error);
          } finally {
            if (hotInFlight?.requestId === currentHotRequestId) {
              hotInFlight = null;
            }
          }
        })();
        hotInFlight = {
          generation: token,
          requestId: currentHotRequestId,
          promise,
        };
        return promise;
      },

      reenter: (session) => {
        const projectPath = get().projectPath;
        if (!projectPath || isPendingSessionId(session.id)) {
          return Promise.resolve();
        }
        // One re-entry per session at a time: a repeated open joins it.
        const inFlight = reentryInFlight.get(session.id);
        if (inFlight?.generation === generation) return inFlight.promise;

        const token = generation;
        const currentRequestId = ++reentryRequestId;
        update({
          reentryResults: withoutKey(get().reentryResults, session.id),
          reenteringSessionIds: withSetItem(
            get().reenteringSessionIds,
            session.id,
            true,
          ),
        });

        const promise = (async () => {
          try {
            const reentry = await api.reenter(projectPath, session.id);
            if (!isCurrentProject(token, projectPath)) return;
            update({
              reentryResults: {
                ...get().reentryResults,
                [session.id]: reentry,
              },
            });
            void load();
          } catch (error) {
            if (!isCurrentProject(token, projectPath)) return;
            update({
              reentryResults: {
                ...get().reentryResults,
                [session.id]: {
                  mode: "error",
                  sessionId: session.id,
                  command: session.resumeCommand,
                  cwd: session.cwd,
                  error: { code: "unknown", message: api.errorMessage(error) },
                },
              },
            });
          } finally {
            if (
              reentryInFlight.get(session.id)?.requestId === currentRequestId
            ) {
              reentryInFlight.delete(session.id);
            }
            if (isCurrentProject(token, projectPath)) {
              update({
                reenteringSessionIds: withSetItem(
                  get().reenteringSessionIds,
                  session.id,
                  false,
                ),
              });
            }
          }
        })();
        reentryInFlight.set(session.id, {
          generation: token,
          requestId: currentRequestId,
          promise,
        });
        return promise;
      },

      openNewSessionTerminal: async (scope, title) => {
        const projectPath = get().projectPath;
        if (!projectPath || scope.status !== "ready") return null;

        const token = generation;
        const openedAt = new Date(now()).toISOString();
        const terminal = await api.spawnTerminal(scope.path, projectPath);
        if (!isCurrentProject(token, projectPath)) {
          await api.closeTerminal(terminal.ptyId);
          return null;
        }

        const pending: PendingAgentSessionTerminal = {
          id: pendingSessionId(terminal.ptyId),
          ptyId: terminal.ptyId,
          title,
          scope,
          cwd: terminal.cwd || scope.path,
          createdAt: openedAt,
        };
        update({ pendingTerminals: [...get().pendingTerminals, pending] });
        void load({ force: true });
        return pending.id;
      },

      closeTerminal: async (sessionId, ptyId) => {
        await api.closeTerminal(ptyId);
        forgetTerminals(new Set([ptyId]));
        update({
          pendingTerminals: get().pendingTerminals.filter(
            (pending) => pending.id !== sessionId,
          ),
        });
        await load();
      },

      releaseTerminal: (ptyId) => {
        const { sessions, reentryResults } = get();
        const known =
          sessions.some((session) => session.runtime?.ptyId === ptyId) ||
          Object.values(reentryResults).some(
            (result) => result.ptyId === ptyId,
          );
        if (!known) return;
        forgetTerminals(new Set([ptyId]));
        void load();
      },

      observeSession: (sessionId) => {
        const change = (delta: number) => {
          const observed = get().observedSessionIds;
          const count = (observed[sessionId] ?? 0) + delta;
          set({
            observedSessionIds:
              count > 0
                ? { ...observed, [sessionId]: count }
                : withoutKey(observed, sessionId),
          });
        };
        change(1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          change(-1);
        };
      },

      requestFastRefresh: () => {
        set({ fastRefreshDemand: get().fastRefreshDemand + 1 });
        let released = false;
        return () => {
          if (released) return;
          released = true;
          set({ fastRefreshDemand: Math.max(0, get().fastRefreshDemand - 1) });
        };
      },
    };
  });
}
