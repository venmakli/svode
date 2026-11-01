import { useMemo } from "react";

import type {
  NavigationItemDisplay,
  NavigationItemSource,
} from "@/features/navigation";

import type { RoutineOwnerInput } from "../api/routines-api";
import { routineScreenIcon } from "../ui/routines-presentation";
import { useRoutineCatalog } from "./use-routine-catalog";

/**
 * The Routines of an owner as navigation rows show them, by Routine id.
 * While a Routine of the owner has no readable id, the read confirms no
 * absence: that Routine may be the one a row names.
 */
export function useRoutineNavigationSource(
  owner: RoutineOwnerInput,
): NavigationItemSource {
  const { state } = useRoutineCatalog(owner);
  const items = state.phase === "ready" ? state.snapshot.items : null;
  return useMemo(() => {
    if (!items) return null;
    const displays = new Map<string, NavigationItemDisplay>();
    for (const item of items) {
      if (item.routineId) {
        displays.set(item.routineId, {
          title: item.name,
          icon: routineScreenIcon(item),
        });
      }
    }
    return {
      items: displays,
      confirmsAbsence: items.every((item) => item.routineId !== null),
    };
  }, [items]);
}
