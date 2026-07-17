import type { ScopeSurfaceContribution, ScopeSurfaceId } from "./types";

export function resolveActiveScopeSurface(
  surfaces: readonly ScopeSurfaceContribution[],
  requestedSurfaceId: ScopeSurfaceId | null | undefined,
): ScopeSurfaceContribution | null {
  if (requestedSurfaceId) {
    const requested = surfaces.find(({ id }) => id === requestedSurfaceId);
    if (requested) return requested;
  }

  return surfaces[0] ?? null;
}
