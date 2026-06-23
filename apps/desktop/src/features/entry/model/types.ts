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

export interface EntryDetailState {
  form: "leaf" | "folder" | "nestedCollection";
  subpageCount: number;
  otherFileCount: number;
}

export interface WriteResult {
  newPath: string | null;
  modifiedFiles: string[];
  modifiedSources?: { spaceId: string | null; path: string }[];
  writeNonce: string;
}

export interface LinkValidationResult {
  url: string;
  exists: boolean;
}
