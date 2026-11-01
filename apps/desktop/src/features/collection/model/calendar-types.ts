import type {
  CollectionView,
  QueryFilter,
  QuerySort,
} from "@/features/collection/query/model";
import type { Page } from "@/features/page";
import type {
  CollectionSchema,
  CollectionPropertyDefinition,
  Column,
  ActorCandidate,
} from "@/features/properties";

export type CalendarScope = "month" | "week" | "day" | "list";

export type CalendarDateKind =
  | "date"
  | "datetime"
  | "date-range"
  | "datetime-range";

export interface CalendarDateValue {
  start: string;
  end: string | null;
  allDay: boolean;
  range: boolean;
  kind: CalendarDateKind;
}

export interface CalendarEventModel {
  item: Page;
  value: CalendarDateValue;
  dateField: string;
  cardFields: string[];
  customColumns: Column[];
  folder: boolean;
  nestedCollection: boolean;
  color: string | null;
}

export interface CalendarViewProps {
  readOnly: boolean;
  name: string;
  view: CollectionView;
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
  calendarScope?: CalendarScope | null;
  createFocusSignal?: number;
  createAsFolder?: boolean;
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
  onCalendarScopeChange?: (scope: CalendarScope) => void;
  onCreatePage: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Page>;
}

export interface CalendarPropertyContext {
  spacePath: string;
  projectPath?: string | null;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  actors: ActorCandidate[];
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField: (item: Page, column: Column, value: unknown) => void;
}

export interface CalendarCreateDraft {
  anchor: { x: number; y: number };
  dateValue: unknown;
  asFolder: boolean;
}
