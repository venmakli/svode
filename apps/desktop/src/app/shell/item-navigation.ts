import type { ScopeOwnerTarget } from "@/features/artifact";
import {
  agentActorNavigationKey,
  contextItemNavigationKey,
  personNavigationKey,
  routineNavigationKey,
  type NavigationItemKey,
  type NavigationKey,
} from "@/features/navigation";
import type { ScopeItemRef, ScopeOwnerRef } from "@/features/scope-surfaces";

/**
 * The navigation key of an item expanded in the main area: its identity at
 * the owner of its domain, in the Space whose Collection shows it. A
 * surface without expandable items has none.
 */
export function itemNavigationKey(
  owner: ScopeOwnerTarget,
  item: ScopeItemRef,
  rootId: string | null,
): NavigationKey | null {
  switch (item.surfaceId) {
    case "routines":
      return routineNavigationKey(
        owner.spaceId,
        owner.kind === "space" ? "." : owner.path,
        item.itemId,
        rootId,
      );
    case "actors":
      return item.presentationId === "agents"
        ? agentActorNavigationKey(owner.spaceId, item.itemId, rootId)
        : personNavigationKey(owner.spaceId, item.itemId, rootId);
    case "context":
      return contextItemNavigationKey(owner.spaceId, item.itemId, rootId);
    default:
      return null;
  }
}

/**
 * Where the key of an item opens: its owner with the item expanded. A
 * Routine of a Collection opens over the Collection, every other item over
 * its Space.
 */
export function itemNavigationTarget(
  key: NavigationItemKey,
  rootId: string,
): { owner: ScopeOwnerTarget; item: ScopeItemRef } {
  const spaceId = key.spaceId ?? rootId;
  const space: ScopeOwnerTarget = { kind: "space", spaceId };
  switch (key.kind) {
    case "routine":
      return {
        owner:
          key.ownerKind === "collection"
            ? { kind: "collection", path: key.ownerPath, spaceId }
            : space,
        item: { surfaceId: "routines", itemId: key.routineId },
      };
    case "agentActor":
      return {
        owner: space,
        item: {
          surfaceId: "actors",
          presentationId: "agents",
          itemId: key.actorId,
        },
      };
    case "person":
      return {
        owner: space,
        item: {
          surfaceId: "actors",
          presentationId: "humans",
          itemId: key.email,
        },
      };
    case "contextItem":
      return {
        owner: space,
        item: { surfaceId: "context", itemId: key.itemId },
      };
  }
}

/**
 * The selection target of a scope owner: a Space by its id, an App by its
 * folder, any other owner of fixed Collections as the Collection at its
 * folder.
 */
export function scopeOwnerTargetOf(owner: ScopeOwnerRef): ScopeOwnerTarget {
  switch (owner.identityKind) {
    case "registered-space":
      return { kind: "space", spaceId: owner.spaceId };
    case "app-directory":
      return {
        kind: "app-directory",
        path: owner.ownerPath,
        spaceId: owner.spaceId,
      };
    default:
      return {
        kind: "collection",
        path: owner.ownerPath,
        spaceId: owner.spaceId,
      };
  }
}
