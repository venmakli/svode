import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import type {
  CollectionSchema,
  CollectionPropertyDefinition,
  RelationOpenTarget,
} from "@/features/properties";

export interface CollectionTableRow {
  entry: Page;
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
  readOnly: boolean;
  name: string;
  view: CollectionView;
  query: UseViewQueryResult;
  schema: CollectionSchema;
  properties: readonly CollectionPropertyDefinition<Page>[];
  collectionPath: string;
  previousCollectionPath?: string | null;
  spacePath: string;
  projectPath?: string | null;
  searchQuery: string;
  filters: QueryFilter[];
  sort: QuerySort[];
  refreshToken: number;
  createFocusSignal?: number;
  createAsFolder?: boolean;
  onClearSearch?: () => void;
  onOpenEntry: (entry: Page) => void;
  onOpenNestedPeek?: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
  onDuplicateEntry: (entry: Page) => void;
  onDeleteEntry: (entry: Page) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Page>;
}
