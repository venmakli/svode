import type { ComponentType, ReactNode } from "react";

export type ScopeCapability = "space" | "collection";

export type ScopePresentation = "full" | "compact";

export type ScopeSurfaceId = "readme" | "collection" | "routines" | "agent";

export type ScopeOwnerKey =
  | `space:${string}`
  | `collection:${string}:${string}`;

export interface ScopeOwnerRef {
  ownerKey: ScopeOwnerKey;
  identityKind: "registered-space" | "collection-directory";
  spaceId: string;
  spacePath: string;
  projectPath: string;
  ownerPath: string;
  readmePath: string;
  capabilities: readonly ScopeCapability[];
}

export interface ScopeSurfaceRenderContext {
  owner: ScopeOwnerRef;
  presentation: ScopePresentation;
}

export interface ScopeSurfaceContribution {
  id: ScopeSurfaceId;
  order: number;
  presentations: readonly ScopePresentation[];
  appliesTo: (owner: ScopeOwnerRef) => boolean;
  label: string;
  icon: ComponentType<{ className?: string }>;
  render: (context: ScopeSurfaceRenderContext) => ReactNode;
}

export type ScopeOpenIntent =
  | { kind: "default" }
  | { kind: "target"; surfaceId: ScopeSurfaceId };
