import type {
  CollectionView,
  QueryFilter,
  QuerySort,
  UseViewQueryResult,
} from "@/features/collection/query";
import type { Entry } from "@/features/entry";
import type {
  CollectionSchema,
  Column,
  Person,
} from "@/features/properties/model";

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

export interface ListRowProps {
  row: ListRowModel;
  density: "compact" | "comfortable";
  cardFields: string[];
  metaColumns: Column[];
  spacePath: string;
  projectPath?: string | null;
  persons: Person[];
  disabledReorder: boolean;
  focused: boolean;
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onUpdateField: (entry: Entry, column: Column, value: unknown) => void;
  onToggle: (entry: Entry) => void;
  onOpen: (entry: Entry, nestedCollection: boolean) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onDuplicate: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  onFocusRow: (path: string) => void;
  onKeyboardMove: (path: string, offset: number) => void;
  rowRef?: (element: HTMLElement | null) => void;
}
