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
  headerActions?: ReactNode;
  /** The "Open with" control of the object in the top bar. */
  openWith?: ReactNode;
  footerActions?: ReactNode;
  /** An editing form keeps the narrow form width; readers get reading width. */
  layout?: "form" | "reader";
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
}

export type CollectionDetailContent = Omit<
  CollectionDetailRequest,
  "selection"
>;
