import { useCallback } from "react";
import { useOpenScopeOwner } from "@/features/artifact";
import type { RoutineAgentActorTarget } from "@/features/routines";
import { getSpaceSnapshot, useSpace } from "@/features/space";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";

/**
 * "Open Agent" of a refused Routine launch: the Agent Actor's detail in the
 * Actors tab of the Space the Routine launches in, after the navigation
 * guards pass; the Actor's editor is one action away there.
 */
export function useOpenAgentActor() {
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const openScopeOwner = useOpenScopeOwner();
  const openSpace = useSpace((state) => state.openSpace);
  const clearActiveSpace = useSpace((state) => state.clearActiveSpace);

  return useCallback(
    ({ actorId, spaceId }: RoutineAgentActorTarget) => {
      void passNavigationGuards().then((ready) => {
        if (!ready) return;
        const { activeRootId, activeSpaceId } = getSpaceSnapshot();
        openContentSurface();
        if (spaceId === activeRootId) {
          if (activeSpaceId) clearActiveSpace();
        } else if (activeSpaceId !== spaceId) void openSpace(spaceId);
        openScopeOwner(
          { kind: "space", spaceId },
          {
            scopeOpenIntent: {
              kind: "target",
              surfaceId: "actors",
              itemId: actorId,
            },
          },
        );
      });
    },
    [clearActiveSpace, openContentSurface, openScopeOwner, openSpace],
  );
}
