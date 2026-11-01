import type { ReactNode } from "react";

import type { PeekNavigationGuard } from "@/features/scope-surfaces";

import type { CollectionActivationContext } from "../runtime/model/types";

/** Where focus returns once the peek closes: the item's row, else a fallback. */
export interface CollectionItemPeekFocus {
  returnFocus?(): HTMLElement | null;
  fallbackFocus?(): HTMLElement | null;
}

/**
 * The peek of a domain's items, with the transitions of the Page Peek: a
 * request to show another object passes the leave guard of the shown one
 * once; a request of the shown object shows it in place.
 */
export interface CollectionItemPeekController<Target> {
  /** The object the peek shows; null while it is closed. */
  readonly target: Target | null;
  /** Changes when the peek shows another object, not a new version of it. */
  readonly sessionKey: string;
  /** Where focus returns when the shown object closes. */
  readonly focus: CollectionItemPeekFocus;
  /** Shows `target`: after creating it, by an addressed request or a link. */
  open(target: Target, focus?: CollectionItemPeekFocus): void;
  /** The `onActivate` of a presentation whose items open in this peek. */
  activation<Item>(
    toTarget: (item: Item, context: CollectionActivationContext) => Target,
  ): (item: Item, context: CollectionActivationContext) => void;
  /** Closes the peek through the leave guard; false when it stays open. */
  close(): Promise<boolean>;
  /** Adds the leave guard of the shown screen; returns its removal. */
  registerNavigationGuard(guard: PeekNavigationGuard): () => void;
}

/**
 * The screen of an object in the peek. The owner gives the values of its
 * parts; the host gives their order and look: the top bar with identity, ⓘ,
 * ⋯, the object's tools and "Open with", then the content header, then the
 * properties and the body.
 */
export interface CollectionItemPeekScreen {
  /** Icon and name in the top bar; the name is the accessible peek title. */
  identity: { icon: ReactNode; name: string };
  /** The ⓘ details next to the identity, see `CollectionItemInfo`. */
  info?: ReactNode;
  /** The ⋯ menu of the object, see `CollectionItemActionsMenu`. */
  menu?: ReactNode;
  /** Tools of the object in the top bar, such as running a Routine. */
  tools?: ReactNode;
  /** The "Open with" control of the object. */
  openWith?: ReactNode;
  /**
   * The content header in the view of the page header; none where it would
   * only repeat the identity of the top bar.
   */
  header?: CollectionItemPeekHeader;
  /** Properties and body below the header. */
  content: ReactNode;
  /** Actions of an editing form below the content, such as Save. */
  footer?: ReactNode;
  /**
   * An editing form keeps the narrow form width; readers get reading width.
   * A surface fills the peek and draws its own top bar, as a document or a
   * media file does; the other parts of the screen stay unused.
   */
  layout?: "form" | "reader" | "surface";
  /** The leave guard of the screen, e.g. of an editing form. */
  canClose?(): boolean | Promise<boolean>;
}

export interface CollectionItemPeekHeader {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
}
