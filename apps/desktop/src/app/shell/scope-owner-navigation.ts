import {
  pathNavigationKey,
  spaceNavigationKey,
  type NavigationItem,
  type NavigationKey,
} from "@/features/navigation";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

/** The navigation key of the object a scope owner surface shows. */
export function scopeOwnerNavigationKey(
  owner: ScopeOwnerRef,
  rootSpaceId: string | null,
): NavigationKey {
  switch (owner.identityKind) {
    case "registered-space":
      return spaceNavigationKey(owner.spaceId, rootSpaceId);
    case "collection-directory":
      return pathNavigationKey(
        "collection",
        owner.ownerPath,
        owner.spaceId,
        rootSpaceId,
      );
    case "app-directory":
      return pathNavigationKey(
        "app",
        owner.ownerPath,
        owner.spaceId,
        rootSpaceId,
      );
    default:
      return pathNavigationKey(
        "page",
        owner.ownerPath,
        owner.spaceId,
        rootSpaceId,
      );
  }
}

export function scopeOwnerNavigationItem(
  owner: ScopeOwnerRef,
  rootSpaceId: string | null,
  display: { title: string; icon: string | null },
): NavigationItem {
  return {
    key: scopeOwnerNavigationKey(owner, rootSpaceId),
    title: display.title,
    ...(display.icon ? { icon: display.icon } : {}),
  };
}
