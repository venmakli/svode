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

export type PageCover =
  | { type: "color"; value: CoverColorName }
  | { type: "image"; path: string; position?: number | null };

export interface PageMeta {
  title: string;
  icon: string | null;
  description?: string | null;
  cover?: PageCover | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

export interface PageWarning {
  kind: string;
  message: string;
  path?: string | null;
}

export interface PageNameConflict {
  parentPath: string | null;
  conflicts: Array<{ path: string; title: string }>;
}

export interface Page {
  meta: PageMeta;
  body: string;
  path: string;
  warnings?: PageWarning[];
  name_conflict?: PageNameConflict;
}

export interface PageDetailState {
  form: "leaf" | "folder" | "nestedCollection";
  subpageCount: number;
  otherFileCount: number;
}

export interface WritePageResult {
  newPath: string | null;
  modifiedFiles: string[];
  modifiedSources?: { spaceId: string | null; path: string }[];
  writeNonce: string;
  warnings: PageWarning[];
}

export interface PageLinkValidationResult {
  url: string;
  exists: boolean;
}
