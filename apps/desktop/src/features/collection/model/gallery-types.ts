import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import type {
  CollectionPropertyDefinition,
  CollectionSchema,
} from "@/features/properties";

export interface GalleryViewProps {
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
  onOpenNestedPeek: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicateEntry: (entry: Page) => void;
  onDeleteEntry: (entry: Page) => void;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Page>;
}
