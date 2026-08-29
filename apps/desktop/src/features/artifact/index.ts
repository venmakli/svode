export {
  closeActiveContent,
  getActiveContentSelection,
  openArtifact,
  openScopeOwner,
  retargetActiveContent,
} from "./api/selection-actions";
export {
  useActiveContentSelection,
  useCloseActiveContent,
  useOpenArtifact,
  useOpenScopeOwner,
  useRetargetActiveContent,
} from "./hooks/use-artifact-selection";
export {
  inferArtifactSourceShape,
  normalizeArtifactTargetPath,
} from "./model/selection-store";
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
