import { useLayoutEffect } from "react";
import { useStore } from "zustand";
import {
  closeManagedTerminalSurface,
  spawnManagedTerminalSurface,
} from "@/features/terminal/session-surface";
import { getNativeErrorMessage } from "@/platform/native/errors";
import {
  hotStatusAgentSessions,
  listAgentSessions,
  reenterAgentSession,
  refreshAgentSessions,
  setAgentSessionPinned,
  type AgentSession as ListedAgentSession,
} from "../api";
import {
  createAgentSessionCatalogStore,
  startAgentSessionCatalogRefresh,
  type AgentSessionCatalogRefreshEnvironment,
  type AgentSessionCatalogState,
} from "../model";

const agentSessionCatalog = createAgentSessionCatalogStore({
  list: listAgentSessions,
  refresh: refreshAgentSessions,
  hotStatus: hotStatusAgentSessions,
  reenter: reenterAgentSession,
  setPinned: setAgentSessionPinned,
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

/** Keeps the accelerated full-list refresh while the returned release is pending. */
export function requestAgentSessionCatalogFastRefresh(): () => void {
  return agentSessionCatalog.getState().requestFastRefresh();
}
