import { useEffect } from "react";
import type { AgentSession } from "@/platform/agent-sessions/agent-sessions-api";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";

export interface TerminalAgentSessionSyncOptions {
  projectPath: string | null;
  /** Sessions from the project session catalog; the panel keeps no list. */
  sessions: AgentSession[] | null;
  /** Asks the catalog owner for accelerated refresh; returns its release. */
  requestSessionRefresh: () => () => void;
}

/**
 * Links terminal panel tabs to agent sessions of the project catalog. The
 * catalog owner decides when sessions are listed; an open panel only asks it
 * for the accelerated refresh that detects agents started in shell tabs.
 */
export function useTerminalAgentSessionSync({
  projectPath,
  sessions,
  requestSessionRefresh,
}: TerminalAgentSessionSyncOptions) {
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const syncAgentSurfaceTabs = useTerminalStore(
    (state) => state.syncAgentSurfaceTabs,
  );
  const syncAgentSessionTabs = useTerminalStore(
    (state) => state.syncAgentSessionTabs,
  );

  useEffect(() => {
    if (!projectPath || !panelOpen) return;
    return requestSessionRefresh();
  }, [panelOpen, projectPath, requestSessionRefresh]);

  useEffect(() => {
    if (!projectPath || panelOpen) return;
    void syncAgentSurfaceTabs().catch((error) => {
      console.warn("Failed to sync terminal agent surfaces:", error);
    });
  }, [panelOpen, projectPath, syncAgentSurfaceTabs]);

  useEffect(() => {
    if (!projectPath || !panelOpen) return;

    void syncAgentSurfaceTabs().catch((error) => {
      console.warn("Failed to refresh terminal agent surfaces:", error);
    });
    if (!sessions) return;
    void syncAgentSessionTabs(projectPath, sessions).catch((error) => {
      console.warn("Failed to refresh terminal agent sessions:", error);
    });
  }, [
    panelOpen,
    projectPath,
    sessions,
    syncAgentSessionTabs,
    syncAgentSurfaceTabs,
  ]);
}
