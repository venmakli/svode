import type { ReactNode } from "react";

import type { Column } from "@/features/properties";
import type {
  CollectionGalleryCardDensity,
  CollectionGalleryCardSize,
} from "../../model/presentation-layout";

export type SystemCollectionRenderer = "list" | "gallery";
export type SystemCollectionStateScope = "session" | "lifecycle";

export type SystemCollectionPresentationLayout<Row> =
  | {
      kind: "list";
      getTitle(row: Row): ReactNode;
      getDescription?(row: Row): ReactNode;
      renderLeading?(row: Row): ReactNode;
      visibleFields: readonly string[];
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
      visibleFields: readonly string[];
    };

export interface SystemCollectionInstance {
  instanceKey: string;
  defaultPresentationId: string;
  stateScope: SystemCollectionStateScope;
  presentations: readonly SystemCollectionPresentationRuntime[];
}

export interface SystemCollectionPresentationInstance<Row> {
  descriptor: SystemCollectionPresentationDescriptor<Row>;
  state: SystemCollectionPresentationState<Row>;
}

export type SystemCollectionPresentationState<Row> =
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
      refreshing?: boolean;
      sourceEmpty?: ReactNode;
      diagnostics?: readonly ReactNode[];
      attention?: ReactNode;
    };

export const systemCollectionPresentationRuntimeBrand: unique symbol = Symbol(
  "systemCollectionPresentationRuntime",
);

export interface SystemCollectionPresentationRuntime {
  readonly [systemCollectionPresentationRuntimeBrand]: true;
}

export interface SystemCollectionPresentationDescriptor<Row> {
  id: string;
  label: string;
  layout: SystemCollectionPresentationLayout<Row>;
  getRowId(row: Row): string;
  fields: readonly SystemCollectionFieldDescriptor<Row>[];
  query: SystemCollectionQueryDescriptor<Row>;
  create?: SystemCollectionCreateAction;
  refresh?: SystemCollectionRefreshAction;
  rowActions?: readonly SystemCollectionRowActionDescriptor<Row>[];
  createDetailRequest?(
    row: Row,
  ): Omit<SystemCollectionDetailRequest, "selection">;
}

export interface SystemCollectionFieldDescriptor<Row> {
  key: string;
  label: string;
  getValue(row: Row): unknown;
  valueSemantics?: SystemCollectionValueSemantics<Row>;
  filter?: SystemCollectionFilterSemantics<Row>;
  sort?: SystemCollectionSortSemantics<Row>;
  edit?: SystemCollectionFieldEdit<Row>;
}

export type SystemCollectionValueSemantics<Row> =
  | { kind: "property"; column: Column }
  | {
      kind: "custom";
      render(value: unknown, row: Row): ReactNode;
    };

export type SystemCollectionFilterSemantics<Row> =
  | { kind: "property" }
  | {
      kind: "custom";
      operators: readonly string[];
      validate(rule: SystemCollectionFilterRule): boolean;
      matches(row: Row, rule: SystemCollectionFilterRule): boolean;
      renderEditor(input: SystemCollectionFilterEditorInput): ReactNode;
    };

export type SystemCollectionSortSemantics<Row> =
  | { kind: "property" }
  | {
      kind: "custom";
      compare(left: Row, right: Row): number;
    };

export interface SystemCollectionFieldEdit<Row> {
  getState(row: Row): SystemCollectionActionState;
  showDisabledReason?: boolean;
  update(row: Row, value: unknown): Promise<void>;
}

export interface SystemCollectionQueryDescriptor<Row> {
  getSearchText?(row: Row): string;
  fixedPredicate?(row: Row): boolean;
  defaultSort?: readonly SystemCollectionSortDescriptor[];
  defaultCompare?(left: Row, right: Row): number;
}

export interface SystemCollectionQueryState {
  readonly search: string;
  readonly filters: readonly SystemCollectionFilterRule[];
  readonly sort: readonly SystemCollectionSortDescriptor[];
}

export type SystemCollectionQueryValidationIssueReason =
  | "search-unavailable"
  | "unknown-field"
  | "invalid-operator"
  | "invalid-value"
  | "unsupported-filter"
  | "unsupported-sort";

export interface SystemCollectionQueryValidationIssue {
  reason: SystemCollectionQueryValidationIssueReason;
  fieldKey?: string;
  operator?: string;
}

export interface SystemCollectionQueryValidationResult {
  query: SystemCollectionQueryState;
  issues: readonly SystemCollectionQueryValidationIssue[];
  reset: boolean;
}

export interface SystemCollectionSortDescriptor {
  fieldKey: string;
  direction: "asc" | "desc";
}

export interface SystemCollectionFilterRule {
  fieldKey: string;
  operator: string;
  value?: unknown;
  values?: readonly unknown[];
}

export interface SystemCollectionFilterEditorInput {
  rule: SystemCollectionFilterRule;
  onChange(rule: SystemCollectionFilterRule): void;
}

export interface SystemCollectionCreateAction {
  id: string;
  label: string;
  getState(): SystemCollectionActionState;
  run(): void | Promise<void>;
}

export interface SystemCollectionRefreshAction {
  id: string;
  label: string;
  getState(): SystemCollectionActionState;
  run(): void | Promise<void>;
}

export interface SystemCollectionRowActionDescriptor<Row> {
  id: string;
  label: string;
  getLabel?(row: Row): string;
  isVisible?(row: Row): boolean;
  getState(row: Row): SystemCollectionActionState;
  run(row: Row): void | Promise<void>;
}

export type SystemCollectionActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "disabled"; reason: string }
  | { status: "error"; message: string };

export interface SystemCollectionDetailSelection {
  instanceKey: string;
  presentationId: string;
  rowId: string;
}

export interface SystemCollectionDetailRequest {
  selection: SystemCollectionDetailSelection;
  title: ReactNode;
  description: ReactNode;
  content: ReactNode;
  headerActions?: ReactNode;
  footerActions?: ReactNode;
  canClose?: () => boolean | Promise<boolean>;
}

export interface SystemCollectionDetailFocusOptions {
  returnFocus?: () => HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
}

export interface SystemCollectionDetailController {
  open(
    request: SystemCollectionDetailRequest,
    focusOptions?: SystemCollectionDetailFocusOptions,
  ): Promise<boolean>;
  close(selection?: SystemCollectionDetailSelection): Promise<boolean>;
  prepareForNavigation(): Promise<boolean>;
}

interface SystemCollectionInteractionErrorBase {
  instanceKey: string;
  presentationId: string;
  targetId?: string;
  message: string;
}

export type SystemCollectionInteractionError =
  | (SystemCollectionInteractionErrorBase & {
      kind: "create" | "refresh";
      rowId?: never;
    })
  | (SystemCollectionInteractionErrorBase & {
      kind: "action" | "detail" | "field";
      rowId: string;
    });

export type SystemCollectionDeveloperDiagnosticCode =
  | "async-field-value"
  | "duplicate-action-id"
  | "duplicate-field-key"
  | "duplicate-instance-key"
  | "duplicate-presentation-id"
  | "duplicate-row-id"
  | "duplicate-visible-field"
  | "field-value-error"
  | "invalid-action-id"
  | "invalid-default-presentation"
  | "invalid-default-sort"
  | "invalid-field-key"
  | "invalid-gallery-card-size"
  | "invalid-gallery-density"
  | "invalid-instance-key"
  | "invalid-layout"
  | "invalid-presentation-id"
  | "invalid-property-adapter"
  | "invalid-row-id"
  | "unknown-visible-field"
  | "row-id-error";

export interface SystemCollectionDeveloperDiagnostic {
  code: SystemCollectionDeveloperDiagnosticCode;
  message: string;
}
