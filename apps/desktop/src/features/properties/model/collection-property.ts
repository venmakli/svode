import type { ReactNode } from "react";

import type { Column } from "./types";

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

export type CollectionPropertyValueSemantics<Row> =
  | {
      kind: "standard";
      standard: CollectionStandardPropertySemantics;
    }
  | {
      kind: "custom";
      render(value: unknown, row: Row): ReactNode;
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

export type CollectionPropertyFilterSemantics<Row> =
  | { kind: "standard" }
  | {
      kind: "custom";
      operators: readonly string[];
      validate(rule: CollectionPropertyFilterRule): boolean;
      matches(row: Row, rule: CollectionPropertyFilterRule): boolean;
      renderEditor(input: CollectionPropertyFilterEditorInput): ReactNode;
    };

export type CollectionPropertySortSemantics<Row> =
  | { kind: "standard" }
  | {
      kind: "custom";
      compare(left: Row, right: Row): number;
    };

export interface CollectionPropertyEdit<Row> {
  getState(row: Row): CollectionPropertyActionState;
  showDisabledReason?: boolean;
  update(row: Row, value: unknown): void | Promise<void>;
}

export interface CollectionPropertyCapabilities<Row> {
  edit?: CollectionPropertyEdit<Row>;
  filter?: CollectionPropertyFilterSemantics<Row>;
  sort?: CollectionPropertySortSemantics<Row>;
}

export interface CollectionPropertyDefinition<Row> {
  key: string;
  label: string;
  origin: CollectionPropertyOrigin;
  owner: CollectionPropertyOwner;
  semantics: CollectionPropertyValueSemantics<Row>;
  capabilities?: CollectionPropertyCapabilities<Row>;
  getValue(row: Row): unknown;
  getAccessibilityLabel?(row: Row): string;
  getApplicability?(row: Row): CollectionPropertyApplicability;
}

export function defineSchemaBackedCollectionProperty<Row>({
  column,
  ...definition
}: Omit<
  CollectionPropertyDefinition<Row>,
  "key" | "label" | "origin" | "owner" | "semantics"
> & {
  column: Column;
  key?: string;
  label?: string;
}): CollectionPropertyDefinition<Row> {
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

export function resolveStandardPropertyColumn<Row>(
  property: CollectionPropertyDefinition<Row>,
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
