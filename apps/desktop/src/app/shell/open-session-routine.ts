import { useCallback } from "react";
import { useOpenScopeOwner } from "@/features/artifact";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import { getSpaceSnapshot, useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";

/**
 * "Open routine" of a session: the Routines tab of the routine's owner in the
 * main area with the routine's detail, after the navigation guards pass. A
 * new main area object also ends the session peek.
 */
export function useOpenSessionRoutine() {
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const openScopeOwner = useOpenScopeOwner();
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);

  return useCallback(
    (routine: RoutineLaunchLink) => {
      void passNavigationGuards().then((ready) => {
        if (!ready) return;
        const { activeRootId, activeSpaceId } = getSpaceSnapshot();
        const spaceId = routine.spaceId ?? activeRootId;
        openContentSurface();
        if (!routine.spaceId) {
          if (activeSpaceId) clearActiveSpace();
        } else if (activeSpaceId !== routine.spaceId)
          void openSpace(routine.spaceId);
        openScopeOwner(
          routine.resolvedOwnerKind === "collection"
            ? { kind: "collection", spaceId, path: routine.ownerPath }
            : { kind: "space", spaceId },
          {
            scopeOpenIntent: {
              kind: "target",
              surfaceId: "routines",
              itemId: routine.routineId,
            },
          },
        );
      });
    },
    [
      clearActiveSpace,
      openContentSurface,
      openScopeOwner,
      openSpace,
    ],
  );
}
