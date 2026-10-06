import { useCallback } from "react";
import { getSpaceSnapshot, useSpace } from "@/features/space";
import { useShellStore } from "./model";

/**
 * A new chat with the active project's root as the main area object; focus
 * goes to its composer.
 */
export function useShowProjectChat() {
  const openSessionDraftMainSurface = useShellStore(
    (state) => state.openSessionDraftMainSurface,
  );
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);
  return useCallback(() => {
    const projectPath = getSpaceSnapshot().activeRootPath;
    if (!projectPath) return;
    clearActiveSpace();
    openSessionDraftMainSurface({
      draftId: crypto.randomUUID(),
      spacePath: projectPath,
    });
  }, [clearActiveSpace, openSessionDraftMainSurface]);
}
