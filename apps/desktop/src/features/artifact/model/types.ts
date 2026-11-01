import type { ScopeOpenIntent } from "@/features/scope-surfaces";

/** The kinds of artifact: page, document, media and App. */
export type ArtifactKind = "page" | "document" | "media" | "app";

/** The kinds the Artifact Registry opens; an App opens through the Apps owner. */
export type ArtifactRegistryKind = Exclude<ArtifactKind, "app">;

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
  scopeOpenIntent?: ScopeOpenIntent;
  target: ArtifactOpenTarget;
}

export interface ActiveArtifactOpenRequest {
  key: number;
  sessionKey: number;
  intent: ArtifactOpenIntent;
}

export type ScopeOwnerTarget =
  | { kind: "space"; spaceId: string | null }
  | { kind: "collection"; spaceId: string | null; path: string }
  | { kind: "app-directory"; spaceId: string | null; path: string };

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
  scopeOpenIntent?: ScopeOpenIntent;
  reveal?: boolean;
  /** Opened from the sidebar: the tree neither expands nor scrolls to it. */
  fromSidebar?: boolean;
}

export interface OpenScopeOwnerOptions {
  reveal?: boolean;
  scopeOpenIntent?: ScopeOpenIntent;
  /** Opened from the sidebar: the tree neither expands nor scrolls to it. */
  fromSidebar?: boolean;
}

export interface ActiveContentSelectionSnapshot {
  selection: ActiveContentSelection | null;
  activeRevealRequest: ContentRevealRequest | null;
  activePathRetarget: ContentPathRetarget | null;
  transitionPending: boolean;
}
