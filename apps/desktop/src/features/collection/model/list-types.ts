import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type { CollectionSchema } from "@/features/properties";

export interface ListViewProps {
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
  onOpenFullPage: (entry: Entry) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onCreateEntry: (title: string, asFolder: boolean) => Promise<Entry>;
}

export interface ListRowModel {
  entry: Entry;
  level: number;
  expandable: boolean;
  expanded: boolean;
  nestedCollection: boolean;
}
