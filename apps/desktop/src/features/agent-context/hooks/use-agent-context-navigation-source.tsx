import { useMemo } from "react";

import type {
  NavigationItemDisplay,
  NavigationItemSource,
} from "@/features/navigation";

import { isAgentContextReadComplete } from "../model/catalog-completeness";
import type { AgentContextSnapshot } from "../model/types";
import { AgentContextItemIcon } from "../ui/item-properties";
import { useAgentContext } from "./use-agent-context";

/**
 * The items of the "Context" of a Space as rows show them, by the id the
 * scanner gives them, with the components of plugins.
 */
export function useAgentContextNavigationSource({
  ownerKey,
  projectPath,
  spacePath,
}: {
  ownerKey: string;
  projectPath: string;
  spacePath: string;
}): NavigationItemSource {
  const { state } = useAgentContext({ ownerKey, projectPath, spacePath });
  const snapshot = state.phase === "ready" ? state.snapshot : null;
  return useMemo(
    () => (snapshot ? agentContextNavigationSource(snapshot) : null),
    [snapshot],
  );
}

/**
 * A read of the "Context" as navigation rows show it. Only a complete read
 * confirms absence; an item of the device that this device does not have is
 * absent.
 */
export function agentContextNavigationSource(
  snapshot: AgentContextSnapshot,
): NonNullable<NavigationItemSource> {
  const displays = new Map<string, NavigationItemDisplay>();
  for (const item of [
    ...snapshot.items,
    ...snapshot.items.flatMap((candidate) => candidate.components),
  ]) {
    displays.set(item.id, {
      title: item.name,
      icon: <AgentContextItemIcon item={item} />,
    });
  }
  return {
    items: displays,
    confirmsAbsence: isAgentContextReadComplete(snapshot),
  };
}
