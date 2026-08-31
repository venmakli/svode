import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import type {
  ActorCandidate,
  CollectionSchema,
  Column,
  PropertyOption,
} from "@/features/properties";

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
  actor?: ActorCandidate | null;
  collapsedByDefault?: boolean;
}

export interface BoardCardModel {
  entry: Page;
  groupKey: string;
}

export interface BoardViewProps {
  readOnly: boolean;
  name: string;
  view: CollectionView;
  query: UseViewQueryResult;
  schema: CollectionSchema;
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
  onOpenNestedPeek: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenFullPage: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicateEntry: (entry: Page) => void;
  onDeleteEntry: (entry: Page) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCreateEntry: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Page>;
}

export interface BoardCardProps {
  readOnly: boolean;
  card: BoardCardModel;
  groupColumn: Column;
  cardFields: string[];
  customColumns: Column[];
  nestedCollectionPaths: Set<string>;
  disabledReorder: boolean;
  active: boolean;
  overlay?: boolean;
  spacePath: string;
  projectPath?: string | null;
  actors: ActorCandidate[];
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Page, column: Column, value: unknown) => void;
  onOpen: (entry: Page) => void;
  onOpenNestedPeek: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenFullPage: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicate: (entry: Page) => void;
  onDelete: (entry: Page) => void;
}
