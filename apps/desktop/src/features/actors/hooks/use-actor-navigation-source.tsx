import { useMemo } from "react";

import { AgentAvatar } from "@/features/identity";
import type {
  NavigationItemDisplay,
  NavigationItemSource,
} from "@/features/navigation";

import type { AgentActorCatalogSnapshot } from "../model/agent-actor-types";
import {
  isAgentActorCatalogReadComplete,
  isPersonCatalogReadComplete,
} from "../model/catalog-completeness";
import type { ActorCatalogSnapshot } from "../model/types";
import { ActorAvatar } from "../ui/actor-avatar";
import { useActorCatalog } from "./use-actor-catalog";
import { useAgentActorCatalog } from "./use-agent-actor-catalog";

/** The people of the repository of a Space as rows show them, by canonical email. */
export function usePersonNavigationSource(
  spacePath: string,
): NavigationItemSource {
  const { state } = useActorCatalog(spacePath);
  const snapshot = state.phase === "ready" ? state.snapshot : null;
  return useMemo(
    () => (snapshot ? personNavigationSource(snapshot) : null),
    [snapshot],
  );
}

/** The Agent Actors a Space shows as rows show them, by Actor id. */
export function useAgentActorNavigationSource(
  projectPath: string,
  spacePath: string,
): NavigationItemSource {
  const { state } = useAgentActorCatalog(projectPath, spacePath);
  const snapshot = state.phase === "ready" ? state.snapshot : null;
  return useMemo(
    () => (snapshot ? agentActorNavigationSource(snapshot) : null),
    [snapshot],
  );
}

/** A read of the people as navigation rows show it; only a complete read confirms absence. */
export function personNavigationSource(
  snapshot: ActorCatalogSnapshot,
): NonNullable<NavigationItemSource> {
  return {
    items: new Map<string, NavigationItemDisplay>(
      snapshot.items.map((item) => [
        item.canonicalEmail,
        {
          title: item.displayName,
          icon: <ActorAvatar actor={item} size="sm" />,
        },
      ]),
    ),
    confirmsAbsence: isPersonCatalogReadComplete(snapshot),
  };
}

/** A read of the Agent Actors as navigation rows show it; only a complete read confirms absence. */
export function agentActorNavigationSource(
  snapshot: AgentActorCatalogSnapshot,
): NonNullable<NavigationItemSource> {
  return {
    items: new Map<string, NavigationItemDisplay>(
      snapshot.items.map((item) => [
        item.id,
        {
          title: item.name,
          icon: <AgentAvatar shape="square" size="sm" />,
        },
      ]),
    ),
    confirmsAbsence: isAgentActorCatalogReadComplete(snapshot),
  };
}
