import { useMemo } from "react";

import type {
  NavigationItemDisplay,
  NavigationItemSource,
} from "@/features/navigation";

import { AgentContextItemIcon } from "../ui/item-properties";
import { useAgentContext } from "./use-agent-context";

/**
 * The items of the "Context" of a Space as rows show them, by the id the
 * scanner gives them, with the components of plugins. An item of the
 * device that this device does not have is absent.
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
  const items = state.phase === "ready" ? state.snapshot.items : null;
  return useMemo(() => {
    if (!items) return null;
    const displays = new Map<string, NavigationItemDisplay>();
    for (const item of [
      ...items,
      ...items.flatMap((candidate) => candidate.components),
    ]) {
      displays.set(item.id, {
        title: item.name,
        icon: <AgentContextItemIcon item={item} />,
      });
    }
    return { items: displays, confirmsAbsence: true };
  }, [items]);
}
