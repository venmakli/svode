import type { ComponentType, ReactNode } from "react";

export type ScopeCapability = "space" | "collection" | "app";

export type ScopePresentation = "full" | "compact";

export type ScopeSurfaceId =
  | "readme"
  | "actors"
  | "attachments"
  | "app"
  | "pages"
  | "routines"
  | "sessions"
  | "context";

export type ScopeOwnerKey =
  | `space:${string}`
  | `collection:${string}:${string}`
  | `page:${string}:${string}`
  | `app:${string}:${string}`;

export interface ScopeOwnerRef {
  ownerKey: ScopeOwnerKey;
  identityKind:
    | "registered-space"
    | "collection-directory"
    | "app-directory"
    | "page-file"
    | "page-directory";
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
  /** An item the open request addressed in this surface, until consumed. */
  openItem?: ScopeOpenItem;
  /**
   * The item of this surface expanded as the main area object: the surface
   * shows the screen of that item instead of its Collection.
   */
  mainItem?: ScopeMainItem;
  /** "Expand" of an item in the surface's peek: the item opens in the main area. */
  onExpandItem?: (item: ScopeItemRef) => void;
}

/**
 * An item of a fixed Collection of an owner, by its id in its surface:
 * a person or an Agent Actor also names its presentation.
 */
export interface ScopeItemRef {
  surfaceId: ScopeSurfaceId;
  itemId: string;
  presentationId?: string;
}

/** The parts of an expanded item's screen the main top bar shows. */
export interface ScopeMainItemTopBar {
  /** Icon and name of the item, the last breadcrumb. */
  identity: { icon: ReactNode; name: string };
  info?: ReactNode;
  menu?: ReactNode;
  tools?: ReactNode;
  openWith?: ReactNode;
}

/**
 * The main area host of an expanded item. The surface gives the screen of
 * the item; the host puts its top bar parts after the breadcrumbs of the
 * owner and the surface, guards leaving it and closes it once it is gone.
 */
export interface ScopeMainItem {
  item: ScopeItemRef;
  renderTopBar(parts: ScopeMainItemTopBar): ReactNode;
  /** Adds a guard every navigation away from the main area passes. */
  registerNavigationGuard(guard: () => Promise<boolean>): () => void;
  /**
   * The ready source has no such item: it leaves Now and Pinned, and the
   * main area closes.
   */
  onGone(): void;
}

export interface ScopeOpenItem {
  id: string;
  /** Marks the request applied, so a remount of the surface does not repeat it. */
  consume(): void;
}

export interface ScopeSurfaceContribution {
  id: ScopeSurfaceId;
  order: number;
  presentations: readonly ScopePresentation[];
  appliesTo: (owner: ScopeOwnerRef) => boolean;
  label: string;
  icon: ComponentType<{ className?: string }>;
  fillAvailableSpace?: boolean;
  render: (context: ScopeSurfaceRenderContext) => ReactNode;
}

export type ScopeOpenIntent =
  | { kind: "default" }
  | { kind: "target"; surfaceId: ScopeSurfaceId; itemId?: string }
  /** The item expanded as the main area object instead of its owner. */
  | { kind: "item"; item: ScopeItemRef };
