import type { Entry } from "@/features/entry";

export type ActiveTab = "document" | string;

export type SettingsPane =
  | "main"
  | "layout"
  | "properties"
  | "propertyAddType"
  | "propertyEdit"
  | "filter"
  | "filterField"
  | "filterEditor"
  | "sort"
  | "sortField"
  | "sortEditor"
  | "group";

export interface EntryDetailState {
  form: "leaf" | "folder" | "nestedCollection";
  subpageCount: number;
  otherFileCount: number;
}

export interface EntryPeekTarget {
  entry: Entry;
  nested: boolean;
  template?: {
    slug: string;
    collectionPath: string;
    isDefault: boolean;
  };
}
