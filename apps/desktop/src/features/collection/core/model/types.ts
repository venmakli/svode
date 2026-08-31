import type { ReactNode } from "react";

import type { CollectionPropertyDefinition } from "@/features/properties";
import type {
  CollectionGalleryCardDensity,
  CollectionGalleryCardSize,
} from "../../model/presentation-layout";

export type CollectionCoreRenderer = "list" | "gallery";
export type CollectionCoreStateScope = "session" | "lifecycle";

export type CollectionCorePresentationLayout<Row> =
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

export interface CollectionCoreInstance {
  instanceKey: string;
  defaultPresentationId: string;
  stateScope: CollectionCoreStateScope;
  presentations: readonly CollectionCorePresentationRuntime[];
}

export interface CollectionCorePresentationInstance<Row> {
  descriptor: CollectionCorePresentationDescriptor<Row>;
  state: CollectionCorePresentationState<Row>;
}

export type CollectionCorePresentationState<Row> =
  | {
      phase: "initial";
      skeleton?: ReactNode;
    }
  | {
      phase: "blocking_error";
      error: ReactNode;
    }
  | {
      phase: "ready";
      rows: readonly Row[];
      sourceEmpty?: ReactNode;
      diagnostics?: readonly ReactNode[];
      attention?: ReactNode;
    };

export const collectionCorePresentationRuntimeBrand: unique symbol = Symbol(
  "collectionCorePresentationRuntime",
);

export interface CollectionCorePresentationRuntime {
  readonly [collectionCorePresentationRuntimeBrand]: true;
}

export interface CollectionCorePresentationDescriptor<Row> {
  id: string;
  label: string;
  layout: CollectionCorePresentationLayout<Row>;
  getRowId(row: Row): string;
  properties: readonly CollectionPropertyDefinition<Row>[];
  query: CollectionCoreQueryDescriptor<Row>;
  create?: CollectionCoreCreateAction;
  rowActions?: readonly CollectionCoreRowActionDescriptor<Row>[];
  onActivate?(
    row: Row,
    context: CollectionCoreActivationContext,
  ): void | Promise<void>;
}

export interface CollectionCoreActivationContext {
  rowId: string;
  actions?: ReactNode;
  returnFocus?(): HTMLElement | null;
  fallbackFocus?(): HTMLElement | null;
}

export interface CollectionCoreQueryDescriptor<Row> {
  getSearchText?(row: Row): string;
  fixedPredicate?(row: Row): boolean;
  defaultSort?: readonly CollectionCoreSortDescriptor[];
  defaultCompare?(left: Row, right: Row): number;
}

export interface CollectionCoreQueryState {
  readonly search: string;
  readonly filters: readonly CollectionCoreFilterRule[];
  readonly sort: readonly CollectionCoreSortDescriptor[];
}

export type CollectionCoreQueryValidationIssueReason =
  | "search-unavailable"
  | "unknown-property"
  | "invalid-operator"
  | "invalid-value"
  | "unsupported-filter"
  | "unsupported-sort";

export interface CollectionCoreQueryValidationIssue {
  reason: CollectionCoreQueryValidationIssueReason;
  propertyKey?: string;
  operator?: string;
}

export interface CollectionCoreQueryValidationResult {
  query: CollectionCoreQueryState;
  issues: readonly CollectionCoreQueryValidationIssue[];
  reset: boolean;
}

export interface CollectionCoreSortDescriptor {
  propertyKey: string;
  direction: "asc" | "desc";
}

export interface CollectionCoreFilterRule {
  propertyKey: string;
  operator: string;
  value?: unknown;
  values?: readonly unknown[];
}

export interface CollectionCoreCreateAction {
  id: string;
  label: string;
  getState(): CollectionCoreActionState;
  run(): void | Promise<void>;
}

export interface CollectionCoreRowActionDescriptor<Row> {
  id: string;
  label: string;
  getLabel?(row: Row): string;
  isVisible?(row: Row): boolean;
  getState(row: Row): CollectionCoreActionState;
  run(row: Row): void | Promise<void>;
}

export type CollectionCoreActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "disabled"; reason: string }
  | { status: "error"; message: string };

interface CollectionCoreInteractionErrorBase {
  instanceKey: string;
  presentationId: string;
  targetId?: string;
  message: string;
}

export type CollectionCoreInteractionError =
  | (CollectionCoreInteractionErrorBase & {
      kind: "create";
      rowId?: never;
    })
  | (CollectionCoreInteractionErrorBase & {
      kind: "action" | "activation" | "property";
      rowId: string;
    });

export type CollectionCoreDeveloperDiagnosticCode =
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
  | "invalid-property-adapter"
  | "invalid-property-origin"
  | "invalid-property-owner"
  | "invalid-row-id"
  | "unknown-visible-property"
  | "row-id-error";

export interface CollectionCoreDeveloperDiagnostic {
  code: CollectionCoreDeveloperDiagnosticCode;
  message: string;
}
