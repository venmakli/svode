import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query";
import type { Entry } from "@/features/editor/types";
import type {
  CollectionSchema,
  Column,
  Person,
  PropertyOption,
} from "@/features/properties/model";

export interface CollectionInfo {
  path: string;
  title: string;
  rowCount?: number;
  row_count?: number;
  nested: boolean;
}

export interface BoardColumnGroup {
  key: string;
  value: string | null;
  label: string;
  option?: PropertyOption | null;
  person?: Person | null;
  collapsedByDefault?: boolean;
}

export interface BoardCardModel {
  entry: Entry;
  groupKey: string;
}

export interface BoardViewProps {
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
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCreateEntry: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Entry>;
}

export interface BoardCardProps {
  card: BoardCardModel;
  groupColumn: Column;
  cardFields: string[];
  customColumns: Column[];
  nestedCollectionPaths: Set<string>;
  disabledReorder: boolean;
  active: boolean;
  overlay?: boolean;
  onOpen: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onDuplicate: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
}
