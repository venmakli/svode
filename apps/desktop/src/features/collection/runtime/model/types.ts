import type { ReactNode } from "react";

import type { CollectionPropertyDefinition } from "@/features/properties";
import type {
  CollectionGalleryCardDensity,
  CollectionGalleryCardSize,
} from "../../model/presentation-layout";

export type CollectionRenderer =
  | "table"
  | "board"
  | "calendar"
  | "list"
  | "gallery";
export type CollectionStateScope = "session" | "lifecycle";

export type CollectionPresentationLayout<Row> =
  | {
      kind: "table";
      primaryProperty: string;
      visibleProperties: readonly string[];
      density?: "compact" | "comfortable";
    }
  | {
      kind: "board";
      groupByProperty: string | null;
      getTitle(row: Row): ReactNode;
      visibleProperties: readonly string[];
    }
  | {
      kind: "calendar";
      dateProperty: string | null;
      getTitle(row: Row): ReactNode;
      visibleProperties: readonly string[];
    }
  | {
      kind: "list";
      getTitle(row: Row): ReactNode;
      getDescription?(row: Row): ReactNode;
      renderLeading?(row: Row): ReactNode;
      visibleProperties: readonly string[];
      density?: "compact" | "comfortable";
    }
  | {
      kind: "gallery";
      cardSize: CollectionGalleryCardSize;
      density: CollectionGalleryCardDensity;
      getTitle(row: Row): ReactNode;
      getDescription?(row: Row): ReactNode;
      renderLeading?(row: Row): ReactNode;
      renderCover?(row: Row): ReactNode;
      renderOverlays?(row: Row): ReactNode;
      visibleProperties: readonly string[];
    };

export interface CollectionDefinition<
  Presentation = CollectionPresentationRuntime,
> {
  defaultPresentationId: string;
  stateScope: CollectionStateScope;
  presentations: readonly Presentation[];
}

export interface CollectionInstance<
  Presentation = CollectionPresentationRuntime,
> extends CollectionDefinition<Presentation> {
  instanceKey: string;
}

export interface CollectionPresentationInstance<Row> {
  descriptor: CollectionPresentationDescriptor<Row>;
  state: CollectionPresentationState<Row>;
}

export type CollectionPresentationState<Row> =
  | {
      phase: "initial";
      skeleton?: ReactNode;
    }
  | {
      phase: "blocking_error";
      error: ReactNode;
    }
  | ({ phase: "ready" } & CollectionSnapshot<Row>);

export interface CollectionSnapshot<Row> {
  rows: readonly Row[];
  sourceEmpty?: ReactNode;
  diagnostics?: readonly ReactNode[];
  attention?: ReactNode;
}

export const collectionPresentationRuntimeBrand: unique symbol = Symbol(
  "collectionPresentationRuntime",
);

export interface CollectionPresentationRuntime {
  readonly [collectionPresentationRuntimeBrand]: true;
}

export interface CollectionPresentationDescriptor<Row> {
  id: string;
  label: string;
  layout: CollectionPresentationLayout<Row>;
  getRowId(row: Row): string;
  properties: readonly CollectionPropertyDefinition<Row>[];
  query: CollectionQueryDescriptor<Row>;
  create?: CollectionCreateCapability;
  rowActions?: readonly CollectionRowActionDescriptor<Row>[];
  onActivate?(
    row: Row,
    context: CollectionActivationContext,
  ): void | Promise<void>;
}

export interface CollectionActivationContext {
  rowId: string;
  actions?: ReactNode;
  returnFocus?(): HTMLElement | null;
  fallbackFocus?(): HTMLElement | null;
}

export interface CollectionQueryDescriptor<Row> {
  getSearchText?(row: Row): string;
  fixedPredicate?(row: Row): boolean;
  defaultSort?: readonly CollectionSortDescriptor[];
  defaultCompare?(left: Row, right: Row): number;
}

export interface CollectionQueryState {
  readonly search: string;
  readonly filters: readonly CollectionFilterRule[];
  readonly sort: readonly CollectionSortDescriptor[];
}

export type CollectionQueryValidationIssueReason =
  | "search-unavailable"
  | "unknown-property"
  | "invalid-operator"
  | "invalid-value"
  | "unsupported-filter"
  | "unsupported-sort";

export interface CollectionQueryValidationIssue {
  reason: CollectionQueryValidationIssueReason;
  propertyKey?: string;
  operator?: string;
}

export interface CollectionQueryValidationResult {
  query: CollectionQueryState;
  issues: readonly CollectionQueryValidationIssue[];
  reset: boolean;
}

export interface CollectionSortDescriptor {
  propertyKey: string;
  direction: "asc" | "desc";
}

export interface CollectionFilterRule {
  propertyKey: string;
  operator: string;
  value?: unknown;
  values?: readonly unknown[];
}

export interface CollectionCreateIntent {
  id: string;
  label: string;
  getState(): CollectionActionState;
  run(): void | Promise<void>;
}

export interface CollectionCreateCapability {
  label: string;
  intents: readonly CollectionCreateIntent[];
}

export interface CollectionRowActionDescriptor<Row> {
  id: string;
  label: string;
  getLabel?(row: Row): string;
  isVisible?(row: Row): boolean;
  getState(row: Row): CollectionActionState;
  run(row: Row): void | Promise<void>;
}

export type CollectionActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "disabled"; reason: string }
  | { status: "error"; message: string };

interface CollectionInteractionErrorBase {
  instanceKey: string;
  presentationId: string;
  targetId?: string;
  message: string;
}

export type CollectionInteractionError =
  | (CollectionInteractionErrorBase & {
      kind: "create";
      rowId?: never;
    })
  | (CollectionInteractionErrorBase & {
      kind: "action" | "activation" | "property";
      rowId: string;
    });

export type CollectionDeveloperDiagnosticCode =
  | "async-property-value"
  | "duplicate-action-id"
  | "duplicate-property-key"
  | "duplicate-instance-key"
  | "duplicate-presentation-id"
  | "duplicate-row-id"
  | "duplicate-visible-property"
  | "property-value-error"
  | "invalid-action-id"
  | "invalid-default-presentation"
  | "invalid-default-sort"
  | "invalid-property-key"
  | "invalid-gallery-card-size"
  | "invalid-gallery-density"
  | "invalid-instance-key"
  | "invalid-layout"
  | "invalid-presentation-id"
  | "invalid-property-capability"
  | "invalid-property-origin"
  | "invalid-property-owner"
  | "invalid-row-id"
  | "unknown-visible-property"
  | "row-id-error";

export interface CollectionDeveloperDiagnostic {
  code: CollectionDeveloperDiagnosticCode;
  message: string;
}
