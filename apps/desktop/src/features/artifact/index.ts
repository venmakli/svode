export {
  closeActiveContent,
  getActiveContentPath,
  getActiveContentSelection,
  getActiveContentSpaceId,
  openArtifact,
  openScopeOwner,
  retargetActiveContent,
} from "./api/selection-actions";
export {
  useActiveContentSelection,
  useActiveContentPath,
  useActiveContentSpaceId,
  useCloseActiveContent,
  useOpenArtifact,
  useOpenScopeOwner,
  useRetargetActiveContent,
} from "./hooks/use-artifact-selection";
export {
  inferArtifactSourceShape,
  normalizeArtifactTargetPath,
  selectedContentPath,
  selectedContentSpaceId,
} from "./model/selection-store";
export { registerActiveContentDeactivation } from "./model/active-surface-deactivation";
export {
  ArtifactSurfaceTransitionSession,
  resolveArtifactSurfaceHost,
} from "./model/surface-host";
export type {
  ArtifactSurfaceAvailability,
  ArtifactSurfaceContribution,
  ArtifactSurfaceRole,
  ArtifactSurfaceTransitionResult,
  ArtifactSurfaceTransitionStep,
  ResolvedArtifactSurfaceHost,
} from "./model/surface-host";
export type {
  ActiveArtifactOpenRequest,
  ActiveContentSelection,
  ActiveContentSelectionSnapshot,
  ActiveScopeOwnerRequest,
  ArtifactKind,
  ArtifactOpenIntent,
  ArtifactOpenTarget,
  ArtifactSourceShape,
  ContentPathRetarget,
  ContentRevealRequest,
  OpenArtifactOptions,
  OpenScopeOwnerOptions,
  ScopeOwnerTarget,
} from "./model/types";
