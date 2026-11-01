import type { ReactNode } from "react";

import type { ActorCandidate, Column } from "./types";

export type CollectionPropertyOrigin =
  | "schema_backed"
  | "owner_defined"
  | "computed"
  | "domain_specific";

export type CollectionPropertyOwner =
  | {
      kind: "schema";
      column: Column;
    }
  | {
      kind: "feature";
      featureId: string;
    };

export type CollectionPropertyApplicability =
  | { status: "applicable" }
  | { status: "hidden" }
  | {
      status: "unavailable";
      label: string;
    };

export type CollectionPropertyActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "disabled"; reason: string }
  | { status: "error"; message: string };

export type CollectionStandardPropertySemantics = Omit<Column, "name">;

/**
 * How the owner draws a value whose type, filter and sort stay standard;
 * without it the standard display of the type draws the value.
 */
export interface CollectionPropertyDisplay<Item> {
  /** The value in a cell; the standard display of the type without it. */
  render?(value: unknown, item: Item): ReactNode;
  /** The value in the item's detail when it differs from the cell. */
  renderDetail?(value: unknown, item: Item): ReactNode;
}

export type CollectionPropertyValueSemantics<Item> =
  | {
      kind: "standard";
      standard: CollectionStandardPropertySemantics;
      display?: CollectionPropertyDisplay<Item>;
    }
  | {
      kind: "custom";
      render(value: unknown, item: Item): ReactNode;
      /** The value in the item's detail when it differs from the cell. */
      renderDetail?(value: unknown, item: Item): ReactNode;
    };

export interface CollectionPropertyFilterRule {
  operator: string;
  value?: unknown;
  values?: readonly unknown[];
}

export interface CollectionPropertyFilterEditorInput {
  rule: CollectionPropertyFilterRule;
  onChange(rule: CollectionPropertyFilterRule): void;
}

export type CollectionPropertyFilterSemantics<Item> =
  | { kind: "standard" }
  | {
      kind: "custom";
      operators: readonly string[];
      validate(rule: CollectionPropertyFilterRule): boolean;
      matches(item: Item, rule: CollectionPropertyFilterRule): boolean;
      renderEditor(input: CollectionPropertyFilterEditorInput): ReactNode;
    };

export type CollectionPropertySortSemantics<Item> =
  | { kind: "standard" }
  | {
      kind: "custom";
      compare(left: Item, right: Item): number;
    };

/**
 * The editing of a property its owner declares. The owner writes: `update`
 * saves one value of one item and rejects with the reason it was not saved,
 * such as a refused write or a version conflict, after which the item shows
 * its values from disk. The owner serializes the writes of one item.
 */
export interface CollectionPropertyEdit<Item> {
  getState(item: Item): CollectionPropertyActionState;
  showDisabledReason?: boolean;
  update(item: Item, value: unknown): void | Promise<void>;
  /** Why a value cannot be saved, checked before `update`; null when it can. */
  validate?(value: unknown, item: Item): string | null;
  /**
   * A composite value edited in a popover of the property panel and saved
   * whole when the popover closes; a cell shows such a value read-only.
   */
  popover?: CollectionPropertyPopoverEditor<Item>;
}

/** The editor of a composite property inside its popover. */
export interface CollectionPropertyPopoverEditor<Item> {
  render(input: CollectionPropertyPopoverEditorInput<Item>): ReactNode;
}

export interface CollectionPropertyPopoverEditorInput<Item> {
  item: Item;
  /** The value being edited; the saved value when the popover opened. */
  draft: unknown;
  /** Why the draft cannot be saved, shown below the editor; null when it can. */
  problem: string | null;
  onDraftChange(draft: unknown): void;
}

export interface CollectionPropertyCapabilities<Item> {
  edit?: CollectionPropertyEdit<Item>;
  filter?: CollectionPropertyFilterSemantics<Item>;
  sort?: CollectionPropertySortSemantics<Item>;
}

/**
 * A common property of the catalog (Stage 11 `04`, 4.A): one meaning in
 * several Collections, declared once.
 */
export type CommonCollectionPropertyId =
  | "title"
  | "updated"
  | "agent"
  | "agents"
  | "state"
  | "space";

export interface CollectionPropertyDefinition<Item> {
  key: string;
  label: string;
  /** Set by the catalog builders only: the common property this one is. */
  common?: CommonCollectionPropertyId;
  origin: CollectionPropertyOrigin;
  owner: CollectionPropertyOwner;
  semantics: CollectionPropertyValueSemantics<Item>;
  capabilities?: CollectionPropertyCapabilities<Item>;
  /** Candidates of a standard `actor` property for its values, picker and filter. */
  actorCandidates?: readonly ActorCandidate[];
  getValue(item: Item): unknown;
  getAccessibilityLabel?(item: Item): string;
  getApplicability?(item: Item): CollectionPropertyApplicability;
}

export function defineSchemaBackedCollectionProperty<Item>({
  column,
  ...definition
}: Omit<
  CollectionPropertyDefinition<Item>,
  "key" | "label" | "origin" | "owner" | "semantics"
> & {
  column: Column;
  key?: string;
  label?: string;
}): CollectionPropertyDefinition<Item> {
  return {
    ...definition,
    key: definition.key ?? column.name,
    label: definition.label ?? column.name,
    origin: "schema_backed",
    owner: { column, kind: "schema" },
    semantics: {
      kind: "standard",
      standard: standardSemanticsFromColumn(column),
    },
  };
}

export function defineOwnerDefinedCollectionProperty<Item>({
  featureId,
  standard,
  ...definition
}: Omit<
  CollectionPropertyDefinition<Item>,
  "origin" | "owner" | "semantics"
> & {
  featureId: string;
  standard: CollectionStandardPropertySemantics;
  display?: CollectionPropertyDisplay<Item>;
}): CollectionPropertyDefinition<Item> {
  return defineFeatureStandardProperty({
    ...definition,
    featureId,
    origin: "owner_defined",
    standard,
  });
}

export function defineComputedCollectionProperty<Item>({
  featureId,
  standard,
  ...definition
}: Omit<
  CollectionPropertyDefinition<Item>,
  "origin" | "owner" | "semantics"
> & {
  featureId: string;
  standard: CollectionStandardPropertySemantics;
  display?: CollectionPropertyDisplay<Item>;
}): CollectionPropertyDefinition<Item> {
  return defineFeatureStandardProperty({
    ...definition,
    featureId,
    origin: "computed",
    standard,
  });
}

export function defineDomainSpecificCollectionProperty<Item>({
  featureId,
  render,
  renderDetail,
  ...definition
}: Omit<
  CollectionPropertyDefinition<Item>,
  "origin" | "owner" | "semantics"
> & {
  featureId: string;
  render(value: unknown, item: Item): ReactNode;
  renderDetail?(value: unknown, item: Item): ReactNode;
}): CollectionPropertyDefinition<Item> {
  return {
    ...definition,
    origin: "domain_specific",
    owner: { featureId, kind: "feature" },
    semantics: renderDetail
      ? { kind: "custom", render, renderDetail }
      : { kind: "custom", render },
  };
}

/** A property its cell edits with the control of its type. */
export function isCellEditableCollectionProperty<Item>(
  property: CollectionPropertyDefinition<Item> | undefined,
): boolean {
  const edit = property?.capabilities?.edit;
  return Boolean(edit && !edit.popover);
}

export function resolveStandardPropertyColumn<Item>(
  property: CollectionPropertyDefinition<Item>,
): Column | null {
  if (property.semantics.kind !== "standard") return null;
  if (property.owner.kind === "schema") return property.owner.column;
  return { ...property.semantics.standard, name: property.key };
}

function standardSemanticsFromColumn(
  column: Column,
): CollectionStandardPropertySemantics {
  const standard = { ...column } as Partial<Column>;
  delete standard.name;
  return standard as CollectionStandardPropertySemantics;
}

function defineFeatureStandardProperty<Item>({
  display,
  featureId,
  origin,
  standard,
  ...definition
}: Omit<
  CollectionPropertyDefinition<Item>,
  "origin" | "owner" | "semantics"
> & {
  display?: CollectionPropertyDisplay<Item>;
  featureId: string;
  origin: "owner_defined" | "computed";
  standard: CollectionStandardPropertySemantics;
}): CollectionPropertyDefinition<Item> {
  return {
    ...definition,
    origin,
    owner: { featureId, kind: "feature" },
    semantics: display
      ? { display, kind: "standard", standard }
      : { kind: "standard", standard },
  };
}
