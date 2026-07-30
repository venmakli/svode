import type { ReactNode } from "react";

import type { Column } from "@/features/properties";

export type SystemCollectionRenderer = "list" | "cards";
export type SystemCollectionStateScope = "session" | "lifecycle";

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
  renderer: SystemCollectionRenderer;
  getRowId(row: Row): string;
  fields: readonly SystemCollectionFieldDescriptor<Row>[];
  query: SystemCollectionQueryDescriptor<Row>;
  create?: SystemCollectionCreateAction;
  rowActions?: readonly SystemCollectionRowActionDescriptor<Row>[];
  renderRowContent(
    row: Row,
    context: SystemCollectionRowRenderContext,
  ): ReactNode;
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

export interface SystemCollectionRowActionDescriptor<Row> {
  id: string;
  label: string;
  getState(row: Row): SystemCollectionActionState;
  run(row: Row): void | Promise<void>;
}

export type SystemCollectionActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "disabled"; reason: string }
  | { status: "error"; message: string };

export interface SystemCollectionRowRenderContext {
  renderField(fieldKey: string): ReactNode;
  renderFieldControl(fieldKey: string): ReactNode;
  renderAction(actionId: string): ReactNode;
  openDetail(): void;
}

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
  actions?: ReactNode;
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
      kind: "create";
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
  | "field-value-error"
  | "invalid-action-id"
  | "invalid-default-presentation"
  | "invalid-default-sort"
  | "invalid-field-key"
  | "invalid-instance-key"
  | "invalid-presentation-id"
  | "invalid-property-adapter"
  | "invalid-row-id"
  | "row-id-error";

export interface SystemCollectionDeveloperDiagnostic {
  code: SystemCollectionDeveloperDiagnosticCode;
  message: string;
}
