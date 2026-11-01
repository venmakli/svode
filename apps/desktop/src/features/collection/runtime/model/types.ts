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

export type CollectionPresentationLayout<Item> =
  | {
      kind: "table";
      primaryProperty: string;
      hierarchy?: {
        getBranch(item: Item): {
          expanded: boolean;
          items: readonly Item[];
          status?: ReactNode;
        } | null;
        getLabel(item: Item): string;
        onToggle(item: Item): void;
      };
      renderLeading?(item: Item): ReactNode;
      visibleProperties: readonly string[];
      density?: "compact" | "comfortable";
    }
  | {
      kind: "board";
      groupByProperty: string | null;
      getTitle(item: Item): ReactNode;
      visibleProperties: readonly string[];
    }
  | {
      kind: "calendar";
      dateProperty: string | null;
      getTitle(item: Item): ReactNode;
      visibleProperties: readonly string[];
    }
  | {
      kind: "list";
      getTitle(item: Item): ReactNode;
      getDescription?(item: Item): ReactNode;
      renderLeading?(item: Item): ReactNode;
      visibleProperties: readonly string[];
      density?: "compact" | "comfortable";
    }
  | {
      kind: "gallery";
      cardSize: CollectionGalleryCardSize;
      density: CollectionGalleryCardDensity;
      getTitle(item: Item): ReactNode;
      getDescription?(item: Item): ReactNode;
      renderLeading?(item: Item): ReactNode;
      renderCover?(item: Item): ReactNode;
      renderOverlays?(item: Item): ReactNode;
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

export interface CollectionPresentationInstance<Item> {
  descriptor: CollectionPresentationDescriptor<Item>;
  state: CollectionPresentationState<Item>;
}

export type CollectionPresentationState<Item> =
  | {
      phase: "initial";
      skeleton?: ReactNode;
    }
  | {
      phase: "blocking_error";
      error: ReactNode;
    }
  | ({ phase: "ready" } & CollectionSnapshot<Item>);

export interface CollectionSnapshot<Item> {
  items: readonly Item[];
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

export interface CollectionPresentationDescriptor<Item> {
  id: string;
  label: string;
  layout: CollectionPresentationLayout<Item>;
  getItemId(item: Item): string;
  properties: readonly CollectionPropertyDefinition<Item>[];
  query: CollectionQueryDescriptor<Item>;
  create?: CollectionCreateCapability;
  itemActions?: readonly CollectionItemActionDescriptor<Item>[];
  onActivate?(
    item: Item,
    context: CollectionActivationContext,
  ): void | Promise<void>;
}

export interface CollectionActivationContext {
  itemId: string;
  /**
   * The item actions menu of the presentation for a version of the activated
   * item, from its current actions; nothing when none is visible.
   */
  actions?(item: unknown): ReactNode;
  returnFocus?(): HTMLElement | null;
  fallbackFocus?(): HTMLElement | null;
}

export interface CollectionQueryDescriptor<Item> {
  getSearchText?(item: Item): string;
  fixedPredicate?(item: Item): boolean;
  defaultSort?: readonly CollectionSortDescriptor[];
  defaultCompare?(left: Item, right: Item): number;
  getSortTieBreakId?(item: Item): string;
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

export interface CollectionItemActionDescriptor<Item> {
  id: string;
  label: string;
  /** Leading icon shown while the action is not pending. */
  icon?: ReactNode;
  getLabel?(item: Item): string;
  isVisible?(item: Item): boolean;
  getState(item: Item): CollectionActionState;
  run(item: Item): void | Promise<void>;
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
      itemId?: never;
    })
  | (CollectionInteractionErrorBase & {
      kind: "action" | "activation" | "property";
      itemId: string;
    });

export type CollectionDeveloperDiagnosticCode =
  | "async-property-value"
  | "duplicate-action-id"
  | "duplicate-property-key"
  | "duplicate-instance-key"
  | "duplicate-presentation-id"
  | "duplicate-item-id"
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
  | "invalid-item-id"
  | "unknown-visible-property"
  | "item-id-error";

export interface CollectionDeveloperDiagnostic {
  code: CollectionDeveloperDiagnosticCode;
  message: string;
}
