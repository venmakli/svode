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
  headerActions?: ReactNode;
  footerActions?: ReactNode;
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
  prepareForNavigation(): Promise<boolean>;
}

export type CollectionDetailContent = Omit<
  CollectionDetailRequest,
  "selection"
>;
