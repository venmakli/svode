import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSpace, useSpaceActions } from "@/features/space";

interface UseRootProjectNavigationInput {
  beforeRootOpen?: () => Promise<boolean>;
  onRootOpened?: () => void;
}

export function useRootProjectNavigation({
  beforeRootOpen,
  onRootOpened,
}: UseRootProjectNavigationInput = {}) {
  const navigate = useNavigate();
  const activeRootId = useSpace((state) => state.activeRootId);
  const { getWindowOpenIntent, openRoot, openRootWindow } = useSpaceActions();

  const enterRoot = useCallback(() => {
    onRootOpened?.();
    navigate({ to: "/space" });
  }, [navigate, onRootOpened]);

  const openProjectInCurrentWindow = useCallback(
    async (id: string) => {
      if (await openRoot(id)) {
        enterRoot();
        return true;
      }
      return false;
    },
    [enterRoot, openRoot],
  );

  const openProject = useCallback(
    async (id: string) => {
      const intent = await getWindowOpenIntent();
      if (!activeRootId || intent?.kind === "home") {
        if (beforeRootOpen && !(await beforeRootOpen())) {
          return false;
        }
        await openProjectInCurrentWindow(id);
        return true;
      }
      await openRootWindow(id);
      return true;
    },
    [
      activeRootId,
      beforeRootOpen,
      getWindowOpenIntent,
      openProjectInCurrentWindow,
      openRootWindow,
    ],
  );

  // A window opens in its own view; the first window of a launch gets the
  // last view from Desktop.
  const openLastProject = useCallback(async () => {
    const intent = await getWindowOpenIntent();
    if (intent?.kind !== "project") return false;
    return openProjectInCurrentWindow(intent.projectId);
  }, [getWindowOpenIntent, openProjectInCurrentWindow]);

  return {
    openLastProject,
    openProject,
  };
}
