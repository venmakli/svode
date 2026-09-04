import type {
  ScopeOwnerRef,
  ScopeSurfaceContribution,
  ScopeSurfaceId,
} from "./types";

export function resolveDefaultScopeSurface(
  owner: ScopeOwnerRef,
): ScopeSurfaceId {
  if (owner.identityKind === "collection-directory") return "collection";
  if (owner.identityKind === "app-directory") return "app";
  return "readme";
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
