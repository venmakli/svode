export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "unique_id"
  | "actor"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "relation";

export type PropertySensitivity = "pii" | "none";

export type ColorName =
  | "neutral"
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "brown";

export type StatusGroup = "todo" | "in_progress" | "done";

export type NumberDisplay = "number" | "percent" | "bar" | "ring";
export type DateDisplay = "short" | "medium" | "long";

export interface PropertyOption {
  name: string;
  color?: ColorName | null;
  icon?: string | null;
  group?: StatusGroup | null;
}

export type RelationScope = "root" | { type: "space"; id: string };

export interface Column {
  name: string;
  type: PropertyType;
  default?: unknown;
  options?: PropertyOption[] | null;
  display?: NumberDisplay | DateDisplay | string | null;
  min?: number | null;
  max?: number | null;
  color?: ColorName | null;
  timeByDefault?: boolean | null;
  rangeByDefault?: boolean | null;
  relation?: string | null;
  relationScope?: RelationScope | null;
  limit?: "one" | null;
  twoWay?: string | null;
  prefix?: string | null;
  next?: number | null;
  multiple?: boolean | null;
  sensitivity?: PropertySensitivity | null;
}

export type ColumnPatch = Partial<
  Pick<
    Column,
    | "default"
    | "options"
    | "display"
    | "min"
    | "max"
    | "color"
    | "timeByDefault"
    | "rangeByDefault"
    | "relation"
    | "relationScope"
    | "limit"
    | "twoWay"
    | "prefix"
    | "next"
    | "multiple"
    | "sensitivity"
  >
>;

export interface CollectionSchema {
  systemFields?: {
    title?: { label?: string | null } | null;
  } | null;
  document?: { label?: string | null } | null;
  templates?: { default?: string | null; order?: string[] | null } | null;
  columns: Column[];
  views?: unknown[];
}

export interface SchemaMutationWarning {
  code: string;
  field: string;
  count: number;
}

export interface ChangeSchemaTypeResult {
  schema: CollectionSchema;
  warnings: SchemaMutationWarning[];
}

export interface EntrySchemaResult {
  schema: CollectionSchema;
  collectionRootPath?: string;
}

export interface ActorCandidate {
  email: string;
  name: string;
  lastCommitAt?: number | null;
  commitCount?: number;
  isMe?: boolean;
}

export interface DateRangeValue {
  start: string;
  end: string;
}

export interface RelationContext {
  spacePath: string;
  projectPath?: string | null;
  projectSpaceId?: string | null;
  spaceId?: string | null;
  currentFilePath?: string | null;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
}

export interface ResolvedRelationEntry {
  title: string;
  icon?: string | null;
  filePath?: string;
  collectionRootPath?: string | null;
}

export interface RelationTarget {
  path: string;
  title: string;
  icon?: string | null;
}

export type RelationTwoWaySchemaStatus =
  | "ok"
  | "not_two_way"
  | "missing_reverse"
  | "incompatible_reverse";

export type RelationDriftKind = "missing_reverse" | "missing_source";

export interface CompatibleReverseChoice {
  name: string;
  twoWay?: string | null;
}

export interface RelationDriftRow {
  kind: RelationDriftKind;
  sourceFilePath: string;
  targetFilePath: string;
  sourceValue: string;
  targetValue: string;
}

export interface RelationDriftSummary {
  missingReverseCount: number;
  missingSourceCount: number;
  rows: RelationDriftRow[];
}

export interface RelationTwoWayDiagnostics {
  collectionPath: string;
  column: string;
  relation?: string | null;
  reverseColumn?: string | null;
  schemaStatus: RelationTwoWaySchemaStatus;
  schemaMessage?: string | null;
  compatibleReverseChoices: CompatibleReverseChoice[];
  drift: RelationDriftSummary;
}

export type RelationRepairStrategy =
  | "from_this_side"
  | "from_related_side"
  | "choose_reverse_column"
  | "create_reverse_column"
  | "detach_two_way";
