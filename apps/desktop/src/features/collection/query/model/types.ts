import type { CollectionSchema, Column, ActorCandidate, PropertyType } from "@/features/properties";

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after"
  | "in"
  | "not_in"
  | "contains_any"
  | "not_contains_any"
  | "is_empty"
  | "is_not_empty"
  | "group_eq"
  | "group_neq"
  | "group_in"
  | "group_not_in";

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
  values?: unknown[];
}

export interface QuerySort {
  field: string;
  desc?: boolean;
}

export type ViewType = "table" | "board" | "calendar" | "list" | "gallery";

export interface CollectionView {
  name: string;
  type: ViewType;
  filter?: QueryFilter[];
  sort?: QuerySort[];
  group_by?: string | null;
  groupBy?: string | null;
  [key: string]: unknown;
}

export interface ViewQueryConfig {
  name: string;
  type: ViewType;
  filter: QueryFilter[];
  sort: QuerySort[];
  groupBy: string | null;
}

export interface ViewQueryPatch {
  filter?: QueryFilter[];
  sort?: QuerySort[];
  groupBy?: string | null;
}

export interface StoredViewQueryState extends ViewQueryPatch {
  baseViewHash: string;
  updatedAt: string;
}

export type QueryFieldKind = "system" | "custom";

export interface QueryField {
  name: string;
  label: string;
  type: PropertyType;
  kind: QueryFieldKind;
  column?: Column;
}

export interface QueryValidationIssue {
  field: string;
  reason: "unknown_field" | "invalid_operator" | "invalid_value" | "invalid_view_type";
}

export interface QueryValidationResult {
  filter: QueryFilter[];
  sort: QuerySort[];
  groupBy: string | null;
  invalidFilters: QueryFilter[];
  invalidSorts: QuerySort[];
  invalidGroupBy: string | null;
  issues: QueryValidationIssue[];
}

export interface ViewQueryResolvedState {
  persistent: ViewQueryConfig;
  ephemeral: StoredViewQueryState | null;
  merged: ViewQueryConfig;
  baseViewHash: string;
  sharedChanged: boolean;
  hasLocalChanges: boolean;
  invalidFilters: QueryFilter[];
  invalidSorts: QuerySort[];
  invalidGroupBy: string | null;
  issues: QueryValidationIssue[];
}

export interface UseViewQueryOptions {
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  viewName: string;
  schema: CollectionSchema;
  view: CollectionView | null | undefined;
}

export interface SaveViewQueryOptions {
  confirmOverwrite?: () => boolean | Promise<boolean>;
}

export interface UseViewQueryResult extends ViewQueryResolvedState {
  storageKey: string;
  setLocalQuery: (patch: ViewQueryPatch) => void;
  clearLocalQuery: (keys?: Array<keyof ViewQueryPatch>) => void;
  saveForAll: (options?: SaveViewQueryOptions) => Promise<CollectionSchema | null>;
  reloadLocalQuery: () => void;
}

export interface QueryEditorActorSource {
  actors?: ActorCandidate[];
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
}
