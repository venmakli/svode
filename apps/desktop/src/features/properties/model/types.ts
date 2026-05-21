export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "person"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "relation";

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
  time_by_default?: boolean | null;
  rangeByDefault?: boolean | null;
  range_by_default?: boolean | null;
  relation?: string | null;
  limit?: "one" | null;
  twoWay?: string | null;
  two_way?: string | null;
}

export interface CollectionSchema {
  systemFields?: {
    title?: { label?: string | null } | null;
  } | null;
  system_fields?: {
    title?: { label?: string | null } | null;
  } | null;
  document?: { label?: string | null } | null;
  templates?: { default?: string | null; order?: string[] | null } | null;
  columns: Column[];
  views?: unknown[];
}

export interface EntrySchemaResult {
  schema: CollectionSchema;
  collectionRootPath?: string;
  collection_root_path?: string;
}

export interface Person {
  email: string;
  name: string;
  lastCommitAt?: number | null;
  last_commit_at?: number | null;
  commitCount?: number;
  commit_count?: number;
  isMe?: boolean;
  is_me?: boolean;
}

export interface DateRangeValue {
  start: string;
  end: string;
}

export interface RelationContext {
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  currentFilePath?: string | null;
  onOpenPath?: (path: string) => void;
}

export interface ResolvedRelationEntry {
  title: string;
  icon?: string | null;
  filePath?: string;
  file_path?: string;
  collectionRootPath?: string | null;
  collection_root_path?: string | null;
}
