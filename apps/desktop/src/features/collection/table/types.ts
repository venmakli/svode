import type { Entry } from "@/features/editor/types";
import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection-query/types";
import type { CollectionSchema } from "@/features/properties/types";

export interface CollectionTableRow {
  entry: Entry;
  level: number;
  child: boolean;
  nestedCollection: boolean;
  nestedSchema?: CollectionSchema | null;
  nestedCollectionPath?: string | null;
}

export interface TableEditingCell {
  path: string;
  field: string;
}

export interface CollectionInfo {
  path: string;
  title: string;
  rowCount?: number;
  row_count?: number;
  nested: boolean;
}

export interface TableViewProps {
  name: string;
  view: CollectionView;
  query: UseViewQueryResult;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  searchQuery: string;
  filters: QueryFilter[];
  sort: QuerySort[];
  refreshToken: number;
  createFocusSignal?: number;
  createAsFolder?: boolean;
  onClearSearch?: () => void;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek?: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Entry>;
}
