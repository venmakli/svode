import { useEffect, useLayoutEffect, useMemo } from "react";
import { useStore } from "zustand";
import { getNavigationState } from "@/features/navigation";
import {
  closeManagedTerminalSurface,
  spawnManagedTerminalSurface,
  subscribeManagedTerminalExit,
} from "@/features/terminal/session-surface";
import { getNativeErrorMessage } from "@/platform/native/errors";
import {
  hotStatusAgentSessions,
  listAgentSessions,
  raiseAgentSessionCatalog,
  reenterAgentSession,
  refreshAgentSessions,
  type AgentSession as ListedAgentSession,
} from "../api";
import {
  activeAgentSessions,
  confirmedMissingAgentSessionKeys,
  createAgentSessionCatalogStore,
  retitledAgentSessionItems,
  startAgentSessionCatalogRefresh,
  type AgentSession,
  type AgentSessionCatalogRefreshEnvironment,
  type AgentSessionCatalogState,
} from "../model";

const agentSessionCatalog = createAgentSessionCatalogStore({
  list: listAgentSessions,
  refresh: refreshAgentSessions,
  raiseCatalog: raiseAgentSessionCatalog,
  hotStatus: hotStatusAgentSessions,
  reenter: reenterAgentSession,
  spawnTerminal: spawnManagedTerminalSurface,
  closeTerminal: closeManagedTerminalSurface,
  errorMessage: getNativeErrorMessage,
});

const browserRefreshEnvironment: AgentSessionCatalogRefreshEnvironment = {
  isVisible: () =>
    typeof document === "undefined" || document.visibilityState === "visible",
  onForegroundChange: (listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    window.addEventListener("focus", listener);
    return () => {
      document.removeEventListener("visibilitychange", listener);
      window.removeEventListener("focus", listener);
    };
  },
  setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearInterval: (intervalId) => window.clearInterval(intervalId),
  now: () => Date.now(),
};

/**
 * Binds the session catalog to the open project and runs its only refresh
 * lifecycle. Mount once in app composition, independent of any screen.
 */
export function useAgentSessionCatalogLifecycle(projectPath: string | null) {
  // Layout effect: passive effects of the same commit already see the project.
  useLayoutEffect(() => {
    agentSessionCatalog.getState().setProject(projectPath);
    if (!projectPath) return;
    return startAgentSessionCatalogRefresh(
      agentSessionCatalog,
      browserRefreshEnvironment,
    );
  }, [projectPath]);

  // A full list that confirms a session is gone removes it from navigation;
  // a listed session keeps its current title as the last known one.
  useEffect(
    () =>
      agentSessionCatalog.subscribe((state, previous) => {
        if (!state.result || state.listedAt === previous.listedAt) return;
        const navigation = getNavigationState();
        if (navigation.projectPath !== state.projectPath) return;
        const items = [...navigation.pinned, ...navigation.kept];
        void navigation.forget(
          confirmedMissingAgentSessionKeys(
            state.result,
            items.map((item) => item.key),
          ),
        );
        for (const item of retitledAgentSessionItems(
          items,
          state.result.sessions,
        )) {
          navigation.retitle(item).catch((error: unknown) => {
            console.error("Failed to update a session title:", error);
          });
        }
      }),
    [],
  );

  // An exited session terminal is no longer live for any consumer.
  useEffect(
    () =>
      subscribeManagedTerminalExit((ptyId) =>
        agentSessionCatalog.getState().releaseTerminal(ptyId),
      ),
    [],
  );
}

export function useAgentSessionCatalog<T>(
  selector: (state: AgentSessionCatalogState) => T,
): T {
  return useStore(agentSessionCatalog, selector);
}

/** Sessions as listed by the read-model, without local pending records. */
export function useListedAgentSessions(): ListedAgentSession[] | null {
  return useStore(
    agentSessionCatalog,
    (state) => state.result?.sessions ?? null,
  );
}

/**
 * The active sessions of the project in their Now order, pending new
 * sessions included.
 */
export function useActiveAgentSessions(): AgentSession[] {
  const sessions = useStore(agentSessionCatalog, (state) => state.sessions);
  return useMemo(() => activeAgentSessions(sessions), [sessions]);
}

/** Keeps the accelerated full-list refresh while the returned release is pending. */
export function requestAgentSessionCatalogFastRefresh(): () => void {
  return agentSessionCatalog.getState().requestFastRefresh();
}
