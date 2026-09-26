import { useCallback } from "react";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import { useTerminalTargets } from "@/features/terminal/hooks/use-terminal-targets";

export function useTerminalPanelToggle() {
  const { projectTarget } = useTerminalTargets();
  const panelOpen = useTerminalStore((state) => state.panelOpen);
  const togglePanel = useTerminalStore((state) => state.togglePanel);
  const toggle = useCallback(() => {
    if (projectTarget) void togglePanel(projectTarget);
  }, [projectTarget, togglePanel]);

  return { panelOpen, available: projectTarget !== null, toggle };
}
