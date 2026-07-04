import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSpaceActions } from "@/features/space";

interface UseRootProjectNavigationInput {
  onRootOpened?: () => void;
}

export function useRootProjectNavigation({
  onRootOpened,
}: UseRootProjectNavigationInput = {}) {
  const navigate = useNavigate();
  const {
    getWindowOpenIntent,
    openLastActiveRoot,
    openRoot,
    openRootWindow,
  } = useSpaceActions();

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
      await openRootWindow(id);
    },
    [openRootWindow],
  );

  const openLastProject = useCallback(async () => {
    const intent = await getWindowOpenIntent();
    if (intent?.kind === "home") return false;
    if (intent?.kind === "project") {
      return openProjectInCurrentWindow(intent.projectId);
    }

    if (await openLastActiveRoot()) {
      enterRoot();
      return true;
    }

    return false;
  }, [
    enterRoot,
    getWindowOpenIntent,
    openLastActiveRoot,
    openProjectInCurrentWindow,
  ]);

  return {
    openLastProject,
    openProject,
  };
}
