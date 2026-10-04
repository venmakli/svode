import { useCallback } from "react";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import { useTerminalTargets } from "@/features/terminal/hooks/use-terminal-targets";

/**
 * Opens a new panel tab in the project root or a ready Space, found by its
 * path; the panel opens and the new tab takes focus.
 */
export function useNewSpaceTerminal() {
  const { projectTarget, spaceTargets } = useTerminalTargets();
  const createTab = useTerminalStore((state) => state.createTab);
  return useCallback(
    (spacePath: string) => {
      const target =
        projectTarget?.path === spacePath
          ? projectTarget
          : spaceTargets.find((item) => item.path === spacePath);
      if (target) void createTab(target);
    },
    [createTab, projectTarget, spaceTargets],
  );
}
