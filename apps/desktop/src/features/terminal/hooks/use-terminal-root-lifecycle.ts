import { useEffect, useRef } from "react";
import { useSpace } from "@/features/space";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";

export function useTerminalRootLifecycle() {
  const activeRootId = useSpace((state) => state.activeRootId);
  const closeAllTabs = useTerminalStore((state) => state.closeAllTabs);
  const previousRootIdRef = useRef(activeRootId);

  useEffect(() => {
    if (previousRootIdRef.current !== activeRootId) {
      closeAllTabs();
      previousRootIdRef.current = activeRootId;
    }
  }, [activeRootId, closeAllTabs]);

  useEffect(() => {
    return () => closeAllTabs();
  }, [closeAllTabs]);
}
