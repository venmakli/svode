import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AgentSessionReentryResult,
  AgentSessionsHotStatusResult,
  AgentSessionsListResult,
} from "../api";
import {
  applyLocalTerminalRuntime,
  buildPendingAgentSession,
  findMatchingSessionForPendingTerminal,
  isPendingSessionId,
  pendingSessionId,
  type LocalSessionTerminal,
  type PendingAgentSessionTerminal,
} from "./pending";
import { hasActionableWait } from "./active";
import { resolveAgentSessionId, type AgentSessionTarget } from "./target";
import type { AgentSession, AgentSessionScopeGroup } from "./types";

/** Backend and terminal effects the project session catalog depends on. */
export interface AgentSessionCatalogApi {
  list: (projectPath: string) => Promise<AgentSessionsListResult>;
  refresh: (projectPath: string) => Promise<AgentSessionsListResult>;
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
  errorMessage: (error: unknown) => string;
}

export interface AgentSessionCatalogLoadOptions {
  force?: boolean;
}

export interface AgentSessionCatalogState {
  projectPath: string | null;
  result: AgentSessionsListResult | null;
  /** Listed sessions with local terminal runtime, followed by pending sessions. */
  sessions: AgentSession[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Completion time of the last successful full list, in epoch ms. */
  listedAt: number | null;
  terminals: Record<string, LocalSessionTerminal>;
  pendingTerminals: PendingAgentSessionTerminal[];
  /** Pending session id → canonical session id after its terminal was matched. */
  pendingHandoffs: Record<string, string>;
  reentryResults: Record<string, AgentSessionReentryResult>;
  reenteringSessionIds: ReadonlySet<string>;
  /** Session ids a consumer keeps under hot status while it shows them. */
  observedSessionIds: Record<string, number>;
  /** Consumers that need the accelerated full-list refresh while visible. */
  fastRefreshDemand: number;

  setProject: (projectPath: string | null) => void;
  load: (options?: AgentSessionCatalogLoadOptions) => Promise<void>;
  /** Loads until a list that started after the call has been read for the target. */
  loadTarget: (target: AgentSessionTarget) => Promise<void>;
  loadHotStatus: (sessionIds: string[]) => Promise<void>;
  reenter: (session: AgentSession) => Promise<void>;
  openNewSessionTerminal: (
    scope: AgentSessionScopeGroup,
    title: string,
  ) => Promise<string | null>;
  closeTerminal: (sessionId: string, ptyId: string) => Promise<void>;
  closeAllTerminals: () => Promise<void>;
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
  | "loadTarget"
  | "loadHotStatus"
  | "reenter"
  | "openNewSessionTerminal"
  | "closeTerminal"
  | "closeAllTerminals"
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
    terminals: {},
    pendingTerminals: [],
    pendingHandoffs: {},
    reentryResults: {},
    reenteringSessionIds: EMPTY_SET,
    observedSessionIds: {},
    fastRefreshDemand: 0,
  };
}

function deriveSessions(
  result: AgentSessionsListResult | null,
  terminals: Record<string, LocalSessionTerminal>,
  pendingTerminals: PendingAgentSessionTerminal[],
): AgentSession[] {
  const listed = (result?.sessions ?? []).map((session) =>
    applyLocalTerminalRuntime(session, terminals[session.id]),
  );
  return [...listed, ...pendingTerminals.map(buildPendingAgentSession)];
}

function withSessions(
  state: AgentSessionCatalogState,
  patch: Partial<CatalogData>,
): Partial<CatalogData> {
  if (
    !("result" in patch) &&
    !("terminals" in patch) &&
    !("pendingTerminals" in patch)
  ) {
    return patch;
  }
  return {
    ...patch,
    sessions: deriveSessions(
      patch.result !== undefined ? patch.result : state.result,
      patch.terminals ?? state.terminals,
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
 * PTYs of the project's session terminals, each once: a session's terminal,
 * its re-entry, a pending new session and a terminal panel tab the catalog
 * recognizes as an agent session. Shell tabs are not among them.
 */
export function sessionTerminalPtyIds(
  state: Pick<
    AgentSessionCatalogState,
    "sessions" | "terminals" | "reentryResults"
  >,
): Set<string> {
  const ptyIds = new Set<string>();
  state.sessions.forEach((session) => {
    if (session.runtime?.ptyId) ptyIds.add(session.runtime.ptyId);
  });
  Object.values(state.terminals).forEach((terminal) => {
    ptyIds.add(terminal.ptyId);
  });
  Object.values(state.reentryResults).forEach((result) => {
    if (result.ptyId) ptyIds.add(result.ptyId);
  });
  return ptyIds;
}

/**
 * Whether an agent works or waits for the user in one of the session
 * terminals, so closing them all interrupts it.
 */
export function sessionTerminalAgentsBusy(
  state: Pick<AgentSessionCatalogState, "sessions" | "terminals">,
): boolean {
  return state.sessions.some(
    (session) =>
      Boolean(session.runtime?.ptyId ?? state.terminals[session.id]) &&
      (session.status === "active" || hasActionableWait(session)),
  );
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

    const reconcilePendingTerminals = (sessions: AgentSession[]) => {
      const { pendingTerminals, terminals, reentryResults, pendingHandoffs } =
        get();
      if (pendingTerminals.length === 0) return {};

      const usedSessionIds = new Set<string>();
      const remaining: PendingAgentSessionTerminal[] = [];
      const nextTerminals = { ...terminals };
      let nextReentryResults = reentryResults;
      const nextHandoffs = { ...pendingHandoffs };
      let matched = false;

      pendingTerminals.forEach((pending) => {
        const match = findMatchingSessionForPendingTerminal(
          pending,
          sessions,
          usedSessionIds,
        );
        if (!match) {
          remaining.push(pending);
          return;
        }
        matched = true;
        usedSessionIds.add(match.id);
        delete nextTerminals[pending.id];
        nextTerminals[match.id] = {
          ptyId: pending.ptyId,
          cwd: pending.cwd,
          createdAt: pending.createdAt,
        };
        nextReentryResults = withoutKey(nextReentryResults, pending.id);
        nextHandoffs[pending.id] = match.id;
      });

      if (!matched) return {};
      return {
        pendingTerminals: remaining,
        terminals: nextTerminals,
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
          const next = force
            ? await api.refresh(projectPath)
            : await api.list(projectPath);
          if (!isCurrentProject(token, projectPath)) return;
          update({
            ...reconcilePendingTerminals(next.sessions),
            result: next,
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

    /** Drops local runtime of terminals that no longer run. */
    const forgetTerminals = (ptyIds: ReadonlySet<string>) => {
      const current = get();
      update({
        result: withoutTerminalRuntime(current.result, ptyIds),
        pendingTerminals: current.pendingTerminals.filter(
          (pending) => !ptyIds.has(pending.ptyId),
        ),
        terminals: Object.fromEntries(
          Object.entries(current.terminals).filter(
            ([, terminal]) => !ptyIds.has(terminal.ptyId),
          ),
        ),
        reentryResults: Object.fromEntries(
          Object.entries(current.reentryResults).filter(
            ([, result]) => !result.ptyId || !ptyIds.has(result.ptyId),
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
            const result = get().result;
            if (result) {
              update({ result: mergeHotStatusSessions(result, hot.sessions) });
            }
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
            const ptyId = reentry.ptyId;
            update({
              ...(ptyId
                ? {
                    terminals: {
                      ...get().terminals,
                      [session.id]: {
                        ptyId,
                        cwd: reentry.cwd ?? reentry.command?.cwd ?? session.cwd,
                        createdAt: new Date(now()).toISOString(),
                      },
                    },
                  }
                : {}),
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
        update({
          pendingTerminals: [...get().pendingTerminals, pending],
          terminals: {
            ...get().terminals,
            [pending.id]: {
              ptyId: pending.ptyId,
              cwd: pending.cwd,
              createdAt: pending.createdAt,
            },
          },
        });
        void load({ force: true });
        return pending.id;
      },

      closeTerminal: async (sessionId, ptyId) => {
        await api.closeTerminal(ptyId);
        forgetTerminals(new Set([ptyId]));
        const { pendingTerminals, terminals } = get();
        update({
          pendingTerminals: pendingTerminals.filter(
            (pending) => pending.id !== sessionId,
          ),
          terminals: withoutKey(terminals, sessionId),
        });
        await load();
      },

      closeAllTerminals: async () => {
        const ptyIds = sessionTerminalPtyIds(get());
        if (ptyIds.size === 0) return;

        const results = await Promise.allSettled(
          Array.from(ptyIds, async (ptyId) => {
            await api.closeTerminal(ptyId);
            return ptyId;
          }),
        );
        const closed = new Set(
          results
            .filter(
              (result): result is PromiseFulfilledResult<string> =>
                result.status === "fulfilled",
            )
            .map((result) => result.value),
        );

        if (closed.size > 0) {
          forgetTerminals(closed);
          await load();
        }

        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed) throw failed.reason;
      },

      releaseTerminal: (ptyId) => {
        const { sessions, terminals, reentryResults } = get();
        const known =
          sessions.some((session) => session.runtime?.ptyId === ptyId) ||
          Object.values(terminals).some(
            (terminal) => terminal.ptyId === ptyId,
          ) ||
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
