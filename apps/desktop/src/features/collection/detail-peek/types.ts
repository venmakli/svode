import type { ReactNode } from "react";

export interface CollectionDetailSelection {
  instanceKey: string;
  presentationId: string;
  rowId: string;
}

export interface CollectionDetailRequest {
  selection: CollectionDetailSelection;
  title: ReactNode;
  description: ReactNode;
  content: ReactNode;
  /**
   * Icon and name of the object in the top bar; the title and description
   * below it then stay for screen readers only.
   */
  identity?: { icon: ReactNode; name: string };
  /** The ⓘ details next to the identity, see `CollectionDetailInfo`. */
  info?: ReactNode;
  headerActions?: ReactNode;
  /** The "Open with" control of the object in the top bar. */
  openWith?: ReactNode;
  footerActions?: ReactNode;
  /**
   * An editing form keeps the narrow form width; readers get reading width.
   * A surface fills the peek and draws its own top bar, as a document or
   * media file does; identity, info and actions of the request stay unused.
   */
  layout?: "form" | "reader" | "surface";
  canClose?: () => boolean | Promise<boolean>;
}

export interface CollectionDetailFocusOptions {
  returnFocus?: () => HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
}

export interface CollectionDetailController {
  open(
    request: CollectionDetailRequest,
    focusOptions?: CollectionDetailFocusOptions,
  ): Promise<boolean>;
  close(selection?: CollectionDetailSelection): Promise<boolean>;
  /**
   * Shows `next`, a request of the same selection, in place of `shown` while
   * `shown` is the open detail, or closes that detail when `next` is null.
   * Once another request took its place or the detail closed, does nothing
   * and resolves false: it never opens or switches the peek.
   */
  update(
    shown: CollectionDetailRequest,
    next: CollectionDetailRequest | null,
  ): Promise<boolean>;
}

export type CollectionDetailContent = Omit<
  CollectionDetailRequest,
  "selection"
>;
