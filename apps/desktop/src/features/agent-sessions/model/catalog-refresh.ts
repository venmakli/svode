import type {
  AgentSessionCatalogState,
  AgentSessionCatalogStore,
} from "./catalog-store";
import { buildHotStatusSessionIds } from "./hot-status";

/** Refresh tunables of the session catalog; not part of the product contract. */
export interface AgentSessionCatalogRefreshIntervals {
  listMs: number;
  fastListMs: number;
  hotMs: number;
  hiddenHotMs: number;
  foregroundMinGapMs: number;
}

export const AGENT_SESSION_CATALOG_REFRESH_INTERVALS: AgentSessionCatalogRefreshIntervals =
  {
    listMs: 45_000,
    fastListMs: 5_000,
    hotMs: 1_500,
    hiddenHotMs: 15_000,
    foregroundMinGapMs: 5_000,
  };

export interface AgentSessionCatalogRefreshEnvironment {
  isVisible: () => boolean;
  /** Calls the listener when the window visibility changes or it regains focus. */
  onForegroundChange: (listener: () => void) => () => void;
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (intervalId: number) => void;
  now: () => number;
}

interface Timer {
  intervalId: number;
  key: string;
}

function needsFastListRefresh(state: AgentSessionCatalogState): boolean {
  return (
    state.fastRefreshDemand > 0 ||
    state.pendingTerminals.length > 0 ||
    state.sessions.some((session) => session.runtime?.provisional === true)
  );
}

function hotStatusKey(state: AgentSessionCatalogState): string {
  return buildHotStatusSessionIds({
    sessions: state.sessions,
    observedSessionIds: Object.keys(state.observedSessionIds),
  }).join("\0");
}

/**
 * The only refresh lifecycle of the project session catalog. While the window
 * is visible it polls the full list (accelerated for pending/provisional
 * records and explicit fast-refresh demand) plus hot status; while hidden it
 * polls only hot status of already known active, pending and provisional
 * records. Returning to the foreground reloads the full list and starts the
 * agent connections an open Sessions collection needs; polls never start one.
 */
export function startAgentSessionCatalogRefresh(
  store: AgentSessionCatalogStore,
  env: AgentSessionCatalogRefreshEnvironment,
  intervals: AgentSessionCatalogRefreshIntervals = AGENT_SESSION_CATALOG_REFRESH_INTERVALS,
): () => void {
  let stopped = false;
  let visible = env.isVisible();
  let listTimer: Timer | null = null;
  let hotTimer: Timer | null = null;
  let hadFastDemand = store.getState().fastRefreshDemand > 0;

  const load = () => {
    void store.getState().load();
  };

  const replaceTimer = (
    current: Timer | null,
    key: string | null,
    delayMs: number,
    tick: () => void,
  ): Timer | null => {
    if (current?.key === key) return current;
    if (current) env.clearInterval(current.intervalId);
    if (key === null) return null;
    return { key, intervalId: env.setInterval(tick, delayMs) };
  };

  const reconcile = () => {
    if (stopped) return;
    const state = store.getState();

    const listDelay = visible
      ? needsFastListRefresh(state)
        ? intervals.fastListMs
        : intervals.listMs
      : null;
    listTimer = replaceTimer(
      listTimer,
      listDelay === null ? null : String(listDelay),
      listDelay ?? 0,
      () => load(),
    );

    const ids = hotStatusKey(state);
    const hotDelay = visible ? intervals.hotMs : intervals.hiddenHotMs;
    const hotKey = ids ? `${hotDelay}\0${ids}` : null;
    if (hotKey !== hotTimer?.key) {
      const sessionIds = ids ? ids.split("\0") : [];
      hotTimer = replaceTimer(hotTimer, hotKey, hotDelay, () => {
        void store.getState().loadHotStatus(sessionIds);
      });
      if (sessionIds.length > 0) {
        void store.getState().loadHotStatus(sessionIds);
      }
    }

    const hasFastDemand = state.fastRefreshDemand > 0;
    const demandStarted = hasFastDemand && !hadFastDemand;
    // Record before loading: load notifies subscribers synchronously.
    hadFastDemand = hasFastDemand;
    if (demandStarted && visible) load();
  };

  const handleForegroundChange = () => {
    const nextVisible = env.isVisible();
    const becameVisible = nextVisible && !visible;
    visible = nextVisible;
    if (nextVisible) {
      const listedAt = store.getState().listedAt;
      if (
        becameVisible ||
        listedAt === null ||
        env.now() - listedAt >= intervals.foregroundMinGapMs
      ) {
        store.getState().raiseCatalog();
        load();
      }
    }
    reconcile();
  };

  const unsubscribeStore = store.subscribe(reconcile);
  const unsubscribeForeground = env.onForegroundChange(handleForegroundChange);
  load();
  reconcile();

  return () => {
    stopped = true;
    unsubscribeStore();
    unsubscribeForeground();
    if (listTimer) env.clearInterval(listTimer.intervalId);
    if (hotTimer) env.clearInterval(hotTimer.intervalId);
    listTimer = null;
    hotTimer = null;
  };
}
