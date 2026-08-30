import type { ScopeOpenIntent } from "@/features/scope-surfaces";

export type ArtifactKind = "page" | "document" | "media" | "app";

export type ArtifactSourceShape = "file" | "directory";

export interface ArtifactSemanticHint {
  kind: "page";
  role?: "standalone" | "collection-item";
}

export interface ArtifactOpenTarget {
  spaceId: string | null;
  path: string;
  sourceShape: ArtifactSourceShape;
  semanticHint?: ArtifactSemanticHint;
}

export interface ArtifactOpenIntent {
  target: ArtifactOpenTarget;
}

export interface ActiveArtifactOpenRequest {
  key: number;
  sessionKey: number;
  intent: ArtifactOpenIntent;
}

export type ScopeOwnerTarget =
  | { kind: "space"; spaceId: string | null }
  | { kind: "collection"; spaceId: string | null; path: string };

export interface ActiveScopeOwnerRequest {
  key: number;
  owner: ScopeOwnerTarget;
  intent: ScopeOpenIntent;
}

export type ActiveContentSelection =
  | { kind: "artifact"; request: ActiveArtifactOpenRequest }
  | { kind: "scope-owner"; request: ActiveScopeOwnerRequest };

export interface ContentRevealRequest {
  key: number;
  path: string;
  spaceId: string | null;
}

export interface ContentPathRetarget {
  key: number;
  fromPath: string;
  path: string;
  spaceId: string | null;
}

export interface OpenArtifactOptions {
  reveal?: boolean;
}

export interface OpenScopeOwnerOptions {
  reveal?: boolean;
  scopeOpenIntent?: ScopeOpenIntent;
}

export interface ActiveContentSelectionSnapshot {
  selection: ActiveContentSelection | null;
  activeRevealRequest: ContentRevealRequest | null;
  activePathRetarget: ContentPathRetarget | null;
  transitionPending: boolean;
}
