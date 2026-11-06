import { useMemo } from "react";

import type {
  NavigationItemDisplay,
  NavigationItemSource,
} from "@/features/navigation";

import type { RoutineOwnerInput } from "../api/routines-api";
import { isRoutineCatalogReadComplete } from "../model/catalog-completeness";
import type { RoutineCatalogSnapshot } from "../model/types";
import { routineScreenIcon } from "../ui/routines-presentation";
import { useRoutineCatalog } from "./use-routine-catalog";

/** The Routines of an owner as navigation rows show them, by Routine id. */
export function useRoutineNavigationSource(
  owner: RoutineOwnerInput,
): NavigationItemSource {
  const { state } = useRoutineCatalog(owner);
  const snapshot = state.phase === "ready" ? state.snapshot : null;
  return useMemo(
    () => (snapshot ? routineNavigationSource(snapshot) : null),
    [snapshot],
  );
}

/**
 * A read of the Routines of an owner as navigation rows show it. Only a
 * complete read confirms absence: a Routine whose file or id the read lost
 * may be the one a row names.
 */
export function routineNavigationSource(
  snapshot: RoutineCatalogSnapshot,
): NonNullable<NavigationItemSource> {
  const displays = new Map<string, NavigationItemDisplay>();
  for (const item of snapshot.items) {
    if (item.routineId) {
      displays.set(item.routineId, {
        title: item.name,
        icon: routineScreenIcon(item),
      });
    }
  }
  return {
    items: displays,
    confirmsAbsence: isRoutineCatalogReadComplete(snapshot),
  };
}
