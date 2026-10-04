import { useCallback } from "react";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";

/**
 * Whether the terminal of this PTY is a tab of the terminal panel, and the
 * action that shows it there, so a session surface never shows it twice.
 */
export function usePanelTerminal(ptyId: string | null) {
  const inPanel = useTerminalStore((state) =>
    ptyId ? state.tabs.some((tab) => tab.ptyId === ptyId) : false,
  );
  const showTabForPty = useTerminalStore((state) => state.showTabForPty);
  const show = useCallback(() => {
    if (ptyId) showTabForPty(ptyId);
  }, [ptyId, showTabForPty]);
  return { inPanel, show };
}
