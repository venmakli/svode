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
  CollectionPropertyDefinition,
  Column,
  PropertyOption,
} from "@/features/properties";

export interface CollectionInfo {
  path: string;
  title: string;
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
  item: Page;
  groupKey: string;
}

export interface BoardViewProps {
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
  onActivateItem: (page: Page) => void;
  onOpenNestedPeek: (item: Page) => void;
  onOpenNestedCollection: (item: Page) => void;
  onOpenFullPage: (item: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCreatePage: (
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
  active: boolean;
  overlay?: boolean;
  spacePath: string;
  projectPath?: string | null;
  actors: ActorCandidate[];
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (item: Page, column: Column, value: unknown) => void;
  onOpen: (item: Page) => void;
  onOpenNestedPeek: (item: Page) => void;
  onOpenNestedCollection: (item: Page) => void;
  onOpenFullPage: (item: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
}
