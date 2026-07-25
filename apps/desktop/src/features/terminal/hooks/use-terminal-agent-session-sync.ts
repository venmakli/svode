import { useEffect } from "react";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import { startCompletionDrivenPolling } from "@/features/terminal/lib/agent-session-sync";

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

    if (!panelOpen) {
      void syncAgentSurfaceTabs().catch((error) => {
        console.warn("Failed to sync terminal agent surfaces:", error);
      });
      return;
    }

    return startCompletionDrivenPolling({
      intervalMs: AGENT_SESSION_SYNC_INTERVAL_MS,
      task: async () => {
        const [surfaceSync, agentSessionSync] = await Promise.allSettled([
          syncAgentSurfaceTabs(),
          syncAgentSessionTabs(projectPath),
        ]);
        if (surfaceSync.status === "rejected") {
          console.warn(
            "Failed to refresh terminal agent surfaces:",
            surfaceSync.reason,
          );
        }
        if (agentSessionSync.status === "rejected") {
          console.warn(
            "Failed to refresh terminal agent sessions:",
            agentSessionSync.reason,
          );
        }
      },
    });
  }, [panelOpen, projectPath, syncAgentSessionTabs, syncAgentSurfaceTabs]);
}
