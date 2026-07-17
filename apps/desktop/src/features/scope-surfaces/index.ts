export {
  createCollectionDirectoryOwner,
  createRegisteredSpaceOwner,
} from "./model/owners";
export {
  hasScopeCapability,
  resolveScopeSurfaceContributions,
  SCOPE_SURFACE_ORDER,
} from "./model/registry";
export { useScopeSurfaceStore } from "./model/surface-store";
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
