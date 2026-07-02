import type {
  CollectionView,
  QueryFilter,
  QuerySort,
} from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type {
  CollectionSchema,
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
  entry: Entry;
  value: CalendarDateValue;
  dateField: string;
  cardFields: string[];
  customColumns: Column[];
  folder: boolean;
  nestedCollection: boolean;
  color: string | null;
}

export interface CalendarViewProps {
  name: string;
  view: CollectionView;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  searchQuery: string;
  filters: QueryFilter[];
  sort: QuerySort[];
  refreshToken: number;
  calendarScope?: CalendarScope | null;
  createFocusSignal?: number;
  createAsFolder?: boolean;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCalendarScopeChange?: (scope: CalendarScope) => void;
  onCreateEntry: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Entry>;
}

export interface CalendarPropertyContext {
  spacePath: string;
  projectPath?: string | null;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  actors: ActorCandidate[];
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField: (entry: Entry, column: Column, value: unknown) => void;
}

export interface CalendarCreateDraft {
  anchor: { x: number; y: number };
  dateValue: unknown;
  asFolder: boolean;
}
