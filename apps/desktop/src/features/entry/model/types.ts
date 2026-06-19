export type CoverColorName =
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

export type EntryCover =
  | { type: "color"; value: CoverColorName }
  | { type: "image"; path: string; position?: number | null };

export interface EntryMeta {
  title: string;
  icon: string | null;
  description?: string | null;
  cover?: EntryCover | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

export interface EntryWarning {
  kind: string;
  message: string;
}

export interface Entry {
  meta: EntryMeta;
  body: string;
  path: string;
  warnings?: EntryWarning[];
}

export interface WriteResult {
  new_path: string | null;
  modified_files: string[];
  modified_sources?: { spaceId: string | null; path: string }[];
  write_nonce: string;
}

export interface EntryTreeNode {
  name: string;
  path: string;
  title: string;
  icon: string | null;
  description?: string | null;
  has_changes: boolean;
  has_schema: boolean;
  parent?: string | null;
  kind?: "document" | "folder" | "collection";
  hasChildren?: boolean;
  has_children?: boolean;
  children: EntryTreeNode[];
}

export type TreeNode = EntryTreeNode;
