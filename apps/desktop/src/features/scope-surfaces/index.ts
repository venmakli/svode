export {
  createCollectionDirectoryOwner,
  createAppDirectoryOwner,
  createRegisteredSpaceOwner,
  createPageOwner,
} from "./model/owners";
export {
  hasScopeCapability,
  supportsScopeAttachments,
  resolveScopeSurfaceContributions,
  SCOPE_SURFACE_ORDER,
} from "./model/registry";
export {
  resolveActiveScopeSurface,
  resolveDefaultScopeSurface,
} from "./model/active-surface";
export { useScopeSurfaceStore } from "./model/surface-store";
export { ScopeSurfaceHost } from "./ui/scope-surface-host";
export { ScopeSurfaceErrorBoundary } from "./ui/scope-surface-error-boundary";
export { ScopeSurfaceTabs } from "./ui/scope-surface-tabs";
export { ScopeSurfaceUnavailable } from "./ui/scope-surface-unavailable";
export { ScopeOwnerFactsError } from "./ui/scope-owner-facts-error";
export type {
  ScopeCapability,
  ScopeOpenIntent,
  ScopeOwnerKey,
  ScopeOwnerRef,
  ScopePresentation,
  ScopeSurfaceContribution,
  ScopeSurfaceId,
  ScopeSurfaceRenderContext,
} from "./model/types";
export type { ScopePeekContext, ScopePeekRenderer } from "./model/peek";
export { knownScopeOwnerFacts } from "./model/owner-facts";
export type { ScopeOwnerFacts, ScopeOwnerTarget } from "./model/owner-facts";
export { useScopeOwner } from "./hooks/use-scope-owner";
export { usePeekNavigation } from "./hooks/use-peek-navigation";
