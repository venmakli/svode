import { useMemo } from "react";

import { AgentAvatar } from "@/features/identity";
import type {
  NavigationItemDisplay,
  NavigationItemSource,
} from "@/features/navigation";

import { ActorAvatar } from "../ui/actor-avatar";
import { useActorCatalog } from "./use-actor-catalog";
import { useAgentActorCatalog } from "./use-agent-actor-catalog";

/** The people of the repository of a Space as rows show them, by canonical email. */
export function usePersonNavigationSource(
  spacePath: string,
): NavigationItemSource {
  const { state } = useActorCatalog(spacePath);
  const items = state.phase === "ready" ? state.snapshot.items : null;
  return useMemo(() => {
    if (!items) return null;
    return {
      items: new Map<string, NavigationItemDisplay>(
        items.map((item) => [
          item.canonicalEmail,
          {
            title: item.displayName,
            icon: <ActorAvatar actor={item} size="sm" />,
          },
        ]),
      ),
      confirmsAbsence: true,
    };
  }, [items]);
}

/** The Agent Actors a Space shows as rows show them, by Actor id. */
export function useAgentActorNavigationSource(
  projectPath: string,
  spacePath: string,
): NavigationItemSource {
  const { state } = useAgentActorCatalog(projectPath, spacePath);
  const items = state.phase === "ready" ? state.snapshot.items : null;
  return useMemo(() => {
    if (!items) return null;
    return {
      items: new Map<string, NavigationItemDisplay>(
        items.map((item) => [
          item.id,
          {
            title: item.name,
            icon: <AgentAvatar shape="square" size="sm" />,
          },
        ]),
      ),
      confirmsAbsence: true,
    };
  }, [items]);
}
