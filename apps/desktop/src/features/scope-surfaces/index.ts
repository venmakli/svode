export {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
} from "./model/owners";
export {
  hasScopeCapability,
  resolveScopeSurfaceContributions,
  SCOPE_SURFACE_ORDER,
} from "./model/registry";
export {
  resolveActiveScopeSurface,
  resolveDefaultScopeSurface,
} from "./model/active-surface";
export { useScopeSurfaceStore } from "./model/surface-store";
export { ScopeSurfaceHost } from "./ui/scope-surface-host";
export { ScopeSurfaceTabs } from "./ui/scope-surface-tabs";
export { ScopeSurfaceUnavailable } from "./ui/scope-surface-unavailable";
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
