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
  const { openLastActiveRoot, openRoot } = useSpaceActions();

  const enterRoot = useCallback(() => {
    onRootOpened?.();
    navigate({ to: "/space" });
  }, [navigate, onRootOpened]);

  const openProject = useCallback(
    async (id: string) => {
      if (await openRoot(id)) {
        enterRoot();
      }
    },
    [enterRoot, openRoot],
  );

  const openLastProject = useCallback(async () => {
    if (await openLastActiveRoot()) {
      enterRoot();
    }
  }, [enterRoot, openLastActiveRoot]);

  return {
    openLastProject,
    openProject,
  };
}
