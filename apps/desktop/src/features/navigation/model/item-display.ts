import type { ReactNode } from "react";
import { create } from "zustand";

/** How the domain of an item shows it in a row: its name and icon. */
export interface NavigationItemDisplay {
  title: string;
  icon: ReactNode;
}

/**
 * The items a domain source read shows, by their id at the owner; null while
 * the source is not read. `confirmsAbsence` is false while the read cannot
 * tell an item that is gone from one whose identity it could not read.
 */
export type NavigationItemSource = {
  items: ReadonlyMap<string, NavigationItemDisplay>;
  confirmsAbsence: boolean;
} | null;

const useItemDisplays = create<{
  displays: ReadonlyMap<string, NavigationItemDisplay>;
}>(() => ({ displays: new Map() }));

/** Records how the domain shows the items of these key ids now. */
export function publishNavigationItemDisplays(
  displays: ReadonlyMap<string, NavigationItemDisplay>,
) {
  const current = useItemDisplays.getState().displays;
  let changed = false;
  for (const [id, display] of displays) {
    const known = current.get(id);
    if (known?.title !== display.title || known.icon !== display.icon) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  useItemDisplays.setState({ displays: new Map([...current, ...displays]) });
}

/** The name and icon the domain last gave the item of `keyId`, if read. */
export function useNavigationItemDisplay(
  keyId: string,
): NavigationItemDisplay | undefined {
  return useItemDisplays((state) => state.displays.get(keyId));
}
