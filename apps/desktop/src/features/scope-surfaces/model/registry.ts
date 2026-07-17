import type {
  ScopeOwnerRef,
  ScopePresentation,
  ScopeSurfaceContribution,
  ScopeSurfaceId,
} from "./types";

export const SCOPE_SURFACE_ORDER: Record<ScopeSurfaceId, number> = {
  readme: 100,
  collection: 200,
  routines: 300,
  agent: 400,
};

export function hasScopeCapability(
  owner: ScopeOwnerRef,
  capability: ScopeOwnerRef["capabilities"][number],
) {
  return owner.capabilities.includes(capability);
}

export function resolveScopeSurfaceContributions(
  contributions: readonly ScopeSurfaceContribution[],
  owner: ScopeOwnerRef,
  presentation: ScopePresentation,
): ScopeSurfaceContribution[] {
  const seenIds = new Set<ScopeSurfaceId>();
  for (const contribution of contributions) {
    if (seenIds.has(contribution.id)) {
      throw new Error(
        `Duplicate scope surface contribution: ${contribution.id}`,
      );
    }
    seenIds.add(contribution.id);
  }

  return contributions
    .filter(
      (contribution) =>
        contribution.presentations.includes(presentation) &&
        contribution.appliesTo(owner),
    )
    .sort(
      (left, right) =>
        left.order - right.order ||
        SCOPE_SURFACE_ORDER[left.id] - SCOPE_SURFACE_ORDER[right.id],
    );
}
