import type {
  ScopeOwnerRef,
  ScopePresentation,
  ScopeSurfaceContribution,
  ScopeSurfaceId,
} from "./types";

/**
 * The surface a new opening of an owner shows when it asks for none: an
 * owner that is only an App, with a README or without, opens on its App in
 * main and in Peek; a Collection opens on its Collection in main, and any
 * other owner, a Collection in Peek included, on its Readme.
 */
export function resolveDefaultScopeSurface(
  owner: ScopeOwnerRef,
  presentation: ScopePresentation = "full",
): ScopeSurfaceId {
  if (isAppOnlyOwner(owner)) return "app";
  if (presentation === "full" && owner.identityKind === "collection-directory")
    return "pages";
  return "readme";
}

function isAppOnlyOwner(owner: ScopeOwnerRef) {
  return (
    owner.identityKind !== "registered-space" &&
    owner.capabilities.includes("app") &&
    !owner.capabilities.includes("collection")
  );
}

export function resolveActiveScopeSurface(
  surfaces: readonly ScopeSurfaceContribution[],
  requestedSurfaceId: ScopeSurfaceId | null | undefined,
  fallbackSurfaceId?: ScopeSurfaceId,
): ScopeSurfaceContribution | null {
  if (requestedSurfaceId) {
    const requested = surfaces.find(({ id }) => id === requestedSurfaceId);
    if (requested) return requested;
  }

  if (fallbackSurfaceId) {
    const fallback = surfaces.find(({ id }) => id === fallbackSurfaceId);
    if (fallback) return fallback;
  }

  return surfaces[0] ?? null;
}
