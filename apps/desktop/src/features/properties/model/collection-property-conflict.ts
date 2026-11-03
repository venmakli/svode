import type { ReactNode } from "react";

export type CollectionPropertyConflictSide = "ours" | "theirs";

/** The value one side gives a disputed property. */
export interface CollectionPropertyConflictVariant<Item> {
  /** The item with the value of this side, to show it as the property does. */
  item: Item;
  /** The side removed the property. */
  deleted: boolean;
  /** The value as text, for a key the panel has no property for. */
  text: string;
}

/** A property both sides of a conflict changed differently. */
export interface CollectionPropertyConflictEntry<Item> {
  key: string;
  /** The label of a key the panel has no property for. */
  label: string;
  ours: CollectionPropertyConflictVariant<Item>;
  theirs: CollectionPropertyConflictVariant<Item>;
  /** How it is decided so far: a side, a value of its control, or not yet. */
  decision: CollectionPropertyConflictSide | "value" | null;
  /** The decided value as text, for a key the panel has no property for. */
  decidedText: string;
}

/**
 * The conflict mode of the property panel (DF-292): the item shows the
 * merged values of both sides of a conflict, read only, and each disputed
 * property its variants until it is decided by a side or by a value of its
 * control, which the owner wires as the property's edit. A conflict with
 * nothing disputed takes the merged values by one action.
 */
export interface CollectionPropertyPanelConflict<Item> {
  disputed: readonly CollectionPropertyConflictEntry<Item>[];
  /** Nothing is disputed and the merged values are taken. */
  accepted: boolean;
  /** The decisions are being written. */
  pending: boolean;
  /** Why the last write of the decisions did not go; they stay. */
  problem?: ReactNode;
  readOnly: boolean;
  onChoose: (key: string, side: CollectionPropertyConflictSide) => void;
  /** Opens the decision of a disputed property again. */
  onReopen: (key: string) => void;
  onAccept: (accepted: boolean) => void;
}
