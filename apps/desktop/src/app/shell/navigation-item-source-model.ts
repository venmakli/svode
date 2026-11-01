import {
  isNavigationItemKey,
  navigationKeyId,
  type NavigationItem,
  type NavigationItemDisplay,
  type NavigationItemKey,
  type NavigationItemSource,
  type NavigationKey,
  type NavigationResolvedItem,
} from "@/features/navigation";

/** The id of an item at the owner of its domain. */
export function domainItemId(key: NavigationItemKey): string {
  switch (key.kind) {
    case "routine":
      return key.routineId;
    case "agentActor":
      return key.actorId;
    case "person":
      return key.email;
    case "contextItem":
      return key.itemId;
  }
}

/**
 * What a read domain source means for its pinned and kept items: how rows
 * show the items it has, the snapshots to retitle to a new name (once per
 * name, `retitled` remembers them) and the items whose absence it confirms.
 */
export function applyNavigationSource(
  items: readonly NavigationResolvedItem[],
  source: NonNullable<NavigationItemSource>,
  retitled: Map<string, string>,
): {
  displays: Map<string, NavigationItemDisplay>;
  retitles: NavigationItem[];
  gone: NavigationKey[];
} {
  const displays = new Map<string, NavigationItemDisplay>();
  const retitles: NavigationItem[] = [];
  const gone: NavigationKey[] = [];
  for (const item of items) {
    if (!isNavigationItemKey(item.key)) continue;
    const id = navigationKeyId(item.key);
    const display = source.items.get(domainItemId(item.key));
    if (!display) {
      if (source.confirmsAbsence) gone.push(item.key);
      continue;
    }
    displays.set(id, display);
    if (display.title !== item.title && retitled.get(id) !== display.title) {
      retitled.set(id, display.title);
      retitles.push({ key: item.key, title: display.title });
    }
  }
  return { displays, retitles, gone };
}
