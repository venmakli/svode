import { useEffect } from "react";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";

const AGENT_SESSION_SYNC_INTERVAL_MS = 5_000;

export function useTerminalAgentSessionSync(projectPath: string | null) {
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const syncAgentSurfaceTabs = useTerminalStore(
    (state) => state.syncAgentSurfaceTabs,
  );
  const syncAgentSessionTabs = useTerminalStore(
    (state) => state.syncAgentSessionTabs,
  );

  useEffect(() => {
    if (!projectPath) return;

    void syncAgentSurfaceTabs().catch((error) => {
      console.warn("Failed to sync terminal agent surfaces:", error);
    });

    if (!panelOpen) return;

    void syncAgentSessionTabs(projectPath).catch((error) => {
      console.warn("Failed to sync terminal agent sessions:", error);
    });

    const interval = window.setInterval(() => {
      void syncAgentSurfaceTabs().catch((error) => {
        console.warn("Failed to refresh terminal agent surfaces:", error);
      });
      void syncAgentSessionTabs(projectPath, { forceRefresh: true }).catch(
        (error) => {
          console.warn("Failed to refresh terminal agent sessions:", error);
        },
      );
    }, AGENT_SESSION_SYNC_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [panelOpen, projectPath, syncAgentSessionTabs, syncAgentSurfaceTabs]);
}
